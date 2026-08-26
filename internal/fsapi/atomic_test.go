package fsapi

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"

	"fsmcp/internal/proto"
)

// sha256Hex is a small test helper: the hex sha256 of data, for building
// if_sha256 preconditions against known fixture content.
func sha256Hex(t *testing.T, data []byte) string {
	t.Helper()
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// assertErrorCode decodes result's single content block as the tool result
// envelope and fails the test unless it is a failure carrying wantCode.
func assertErrorCode(t *testing.T, result *proto.CallToolResult, wantCode string) {
	t.Helper()
	if result == nil {
		t.Fatalf("result is nil, want an error result with code %q", wantCode)
	}
	if len(result.Content) != 1 {
		t.Fatalf("unexpected content: %+v", result.Content)
	}
	var decoded map[string]any
	if err := json.Unmarshal([]byte(result.Content[0].Text), &decoded); err != nil {
		t.Fatalf("content not valid JSON: %v (%s)", err, result.Content[0].Text)
	}
	if decoded["ok"] != false {
		t.Fatalf("ok = %v, want false", decoded["ok"])
	}
	errObj, ok := decoded["error"].(map[string]any)
	if !ok {
		t.Fatalf("error field missing or malformed: %v", decoded)
	}
	if errObj["code"] != wantCode {
		t.Errorf("code = %v, want %v", errObj["code"], wantCode)
	}
}

func TestAtomicReplaceCreatesNewFile(t *testing.T) {
	root, rootDir := newTestRoot(t)
	if err := AtomicReplace(root, "new.txt", []byte("hello")); err != nil {
		t.Fatalf("AtomicReplace: %v", err)
	}
	got, err := os.ReadFile(filepath.Join(rootDir, "new.txt"))
	if err != nil {
		t.Fatalf("reading created file: %v", err)
	}
	if string(got) != "hello" {
		t.Errorf("content = %q, want %q", got, "hello")
	}
}

func TestAtomicReplaceOverwritesExistingContent(t *testing.T) {
	root, rootDir := newTestRoot(t)
	if err := AtomicReplace(root, "file.txt", []byte("new content")); err != nil {
		t.Fatalf("AtomicReplace: %v", err)
	}
	got, err := os.ReadFile(filepath.Join(rootDir, "file.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "new content" {
		t.Errorf("content = %q, want %q", got, "new content")
	}
}

func TestAtomicReplaceRefusesNonRegularTarget(t *testing.T) {
	root, _ := newTestRoot(t)
	if err := AtomicReplace(root, "sub", []byte("x")); err != errNotRegularFile {
		t.Errorf("AtomicReplace on a directory = %v, want errNotRegularFile", err)
	}
}

func TestAtomicReplaceNoTempFileLeftAfterSuccess(t *testing.T) {
	root, rootDir := newTestRoot(t)
	if err := AtomicReplace(root, "file.txt", []byte("x")); err != nil {
		t.Fatalf("AtomicReplace: %v", err)
	}
	assertNoTempFiles(t, rootDir)
}

func TestAtomicReplaceNoTempFileLeftAfterAttrFailure(t *testing.T) {
	root, rootDir := newTestRoot(t)
	target := filepath.Join(rootDir, "unreadable.txt")
	if err := os.WriteFile(target, []byte("secret"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(target, 0o000); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(target, 0o644) })

	err := AtomicReplace(root, "unreadable.txt", []byte("new"))
	if err != errAttrsUnpreservable {
		t.Fatalf("AtomicReplace on an unreadable target = %v, want errAttrsUnpreservable", err)
	}
	os.Chmod(target, 0o644)
	got, rerr := os.ReadFile(target)
	if rerr != nil {
		t.Fatal(rerr)
	}
	if string(got) != "secret" {
		t.Errorf("target content changed on a refused replace: %q", got)
	}
	assertNoTempFiles(t, rootDir)
}

func assertNoTempFiles(t *testing.T, dir string) {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".fsmcp-tmp-") {
			t.Errorf("temp file left behind: %s", e.Name())
		}
	}
}

func TestAtomicReplacePreservesExactModeUnderUmask(t *testing.T) {
	old := syscall.Umask(0o077)
	defer syscall.Umask(old)

	for _, mode := range []os.FileMode{0o644, 0o600, 0o755} {
		t.Run(mode.String(), func(t *testing.T) {
			root, rootDir := newTestRoot(t)
			target := filepath.Join(rootDir, "mode.txt")
			if err := os.WriteFile(target, []byte("x"), mode); err != nil {
				t.Fatal(err)
			}
			if err := os.Chmod(target, mode); err != nil {
				t.Fatal(err)
			}

			if err := AtomicReplace(root, "mode.txt", []byte("new content")); err != nil {
				t.Fatalf("AtomicReplace: %v", err)
			}

			fi, err := os.Stat(target)
			if err != nil {
				t.Fatal(err)
			}
			if fi.Mode().Perm() != mode {
				t.Errorf("mode after replace = %o, want %o", fi.Mode().Perm(), mode)
			}
		})
	}
}

func TestAtomicReplaceDropsSetuid(t *testing.T) {
	root, rootDir := newTestRoot(t)
	target := filepath.Join(rootDir, "suid.txt")
	if err := os.WriteFile(target, []byte("x"), 0o755); err != nil {
		t.Fatal(err)
	}
	// os.Chmod cannot be handed a raw 04000-style literal — Go's FileMode
	// encodes setuid as a distinct high bit, not the traditional octal
	// value — so the setuid bit is set the same way the CLI does it.
	if out, err := exec.Command("chmod", "4755", target).CombinedOutput(); err != nil {
		t.Skipf("could not set setuid bit: %v (%s)", err, out)
	}
	fi, err := os.Stat(target)
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode()&os.ModeSetuid == 0 {
		t.Skip("could not set setuid bit on this filesystem; nothing to test")
	}

	if err := AtomicReplace(root, "suid.txt", []byte("new")); err != nil {
		t.Fatalf("AtomicReplace: %v", err)
	}
	fi, err = os.Stat(target)
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode()&os.ModeSetuid != 0 {
		t.Errorf("replacement kept the setuid bit: mode %v", fi.Mode())
	}
	if fi.Mode().Perm() != 0o755 {
		t.Errorf("replacement permission bits = %o, want 0755", fi.Mode().Perm())
	}
}

func TestAtomicReplaceBreaksHardLink(t *testing.T) {
	root, rootDir := newTestRoot(t)
	target := filepath.Join(rootDir, "linked.txt")
	if err := os.WriteFile(target, []byte("original"), 0o644); err != nil {
		t.Fatal(err)
	}
	linkPath := filepath.Join(rootDir, "linked-alias.txt")
	if err := os.Link(target, linkPath); err != nil {
		t.Skipf("hard links unsupported on this filesystem: %v", err)
	}

	if err := AtomicReplace(root, "linked.txt", []byte("replaced")); err != nil {
		t.Fatalf("AtomicReplace: %v", err)
	}

	newContent, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if string(newContent) != "replaced" {
		t.Errorf("target content = %q, want %q", newContent, "replaced")
	}

	// Deliberate, per DESIGN.md: a replace breaks a hard link to the
	// target rather than editing in place, because in-place truncation
	// is not crash-safe. The sibling name keeps the old content.
	linkContent, err := os.ReadFile(linkPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(linkContent) != "original" {
		t.Errorf("hard-linked sibling content = %q, want unchanged %q", linkContent, "original")
	}
}

func TestAtomicReplacePreservesXattrAndACL(t *testing.T) {
	if _, err := exec.LookPath("xattr"); err != nil {
		t.Skip("xattr(1) not available")
	}
	root, rootDir := newTestRoot(t)
	target := filepath.Join(rootDir, "attrs.txt")
	if err := os.WriteFile(target, []byte("attrs"), 0o644); err != nil {
		t.Fatal(err)
	}
	if out, err := exec.Command("xattr", "-w", "com.example.marker", "fsmcp-test-canary", target).CombinedOutput(); err != nil {
		t.Skipf("could not set a test xattr: %v (%s)", err, out)
	}
	// An allow ACE: it survives the replace like any other, without denying
	// the rename the replace commits through. A "deny delete" ACE is a
	// different case entirely and has its own test below.
	if out, err := exec.Command("chmod", "+a", "everyone allow read", target).CombinedOutput(); err != nil {
		t.Skipf("could not set a test ACL: %v (%s)", err, out)
	}

	before := xattrListing(t, target)
	beforeACL := aclListing(t, target)

	if err := AtomicReplace(root, "attrs.txt", []byte("new attrs content")); err != nil {
		t.Fatalf("AtomicReplace: %v", err)
	}

	after := xattrListing(t, target)
	afterACL := aclListing(t, target)

	if before != after {
		t.Errorf("xattr -l changed:\nbefore: %q\nafter:  %q", before, after)
	}
	if beforeACL != afterACL {
		t.Errorf("ls -le ACL changed:\nbefore: %q\nafter:  %q", beforeACL, afterACL)
	}

	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "new attrs content" {
		t.Errorf("content = %q, want %q", got, "new attrs content")
	}
}

func xattrListing(t *testing.T, path string) string {
	t.Helper()
	out, err := exec.Command("xattr", "-l", path).CombinedOutput()
	if err != nil {
		t.Fatalf("xattr -l: %v (%s)", err, out)
	}
	return string(out)
}

func aclListing(t *testing.T, path string) string {
	t.Helper()
	out, err := exec.Command("ls", "-le", path).CombinedOutput()
	if err != nil {
		t.Fatalf("ls -le: %v (%s)", err, out)
	}
	// The first line carries the file's own name/size; the ACL entries
	// (everything after) are what this test cares about preserving.
	lines := strings.SplitN(string(out), "\n", 2)
	if len(lines) < 2 {
		return ""
	}
	return lines[1]
}

func TestParsePrecondition(t *testing.T) {
	validHash := strings.Repeat("a", 64)
	cases := []struct {
		name     string
		raw      string
		present  bool // whether the field is present at all in the JSON
		want     preconditionKind
		wantHash string
		wantOK   bool
	}{
		{"absent", "", false, preconditionAbsent, "", true},
		{"explicit null", "null", true, preconditionCreate, "", true},
		{"valid hash", `"` + validHash + `"`, true, preconditionHash, validHash, true},
		{"uppercase hex rejected", `"` + strings.ToUpper(validHash) + `"`, true, 0, "", false},
		{"too short rejected", `"abc123"`, true, 0, "", false},
		{"non-hex rejected", `"` + strings.Repeat("g", 64) + `"`, true, 0, "", false},
		{"wrong type rejected", `12345`, true, 0, "", false},
		{"empty string rejected", `""`, true, 0, "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var raw []byte
			if tc.present {
				raw = []byte(tc.raw)
			}
			kind, hash, ok := parsePrecondition(raw)
			if ok != tc.wantOK {
				t.Fatalf("ok = %v, want %v", ok, tc.wantOK)
			}
			if !tc.wantOK {
				return
			}
			if kind != tc.want {
				t.Errorf("kind = %v, want %v", kind, tc.want)
			}
			if hash != tc.wantHash {
				t.Errorf("hash = %q, want %q", hash, tc.wantHash)
			}
		})
	}
}

func TestCheckPrecondition(t *testing.T) {
	root, _ := newTestRoot(t)
	fileHash := sha256Hex(t, []byte("hello")) // matches file.txt's fixture content

	t.Run("existing file, matching hash", func(t *testing.T) {
		data, failure := checkPrecondition(root, "file.txt", preconditionHash, fileHash)
		if failure != nil {
			t.Fatalf("unexpected failure: %+v", failure)
		}
		if string(data) != "hello" {
			t.Errorf("data = %q, want %q", data, "hello")
		}
	})

	t.Run("existing file, wrong hash", func(t *testing.T) {
		_, failure := checkPrecondition(root, "file.txt", preconditionHash, strings.Repeat("0", 64))
		assertErrorCode(t, failure, "precondition_failed")
	})

	t.Run("existing file, null precondition", func(t *testing.T) {
		_, failure := checkPrecondition(root, "file.txt", preconditionCreate, "")
		assertErrorCode(t, failure, "exists")
	})

	t.Run("missing file, null precondition", func(t *testing.T) {
		data, failure := checkPrecondition(root, "nope.txt", preconditionCreate, "")
		if failure != nil {
			t.Fatalf("unexpected failure: %+v", failure)
		}
		if data != nil {
			t.Errorf("data = %v, want nil", data)
		}
	})

	t.Run("missing file, hash precondition", func(t *testing.T) {
		_, failure := checkPrecondition(root, "nope.txt", preconditionHash, fileHash)
		assertErrorCode(t, failure, "not_found")
	})

	t.Run("directory target", func(t *testing.T) {
		_, failure := checkPrecondition(root, "sub", preconditionHash, fileHash)
		assertErrorCode(t, failure, "not_a_file")
	})
}

// TestAtomicReplaceRefusesUndeletableTarget pins the refusal rather than a
// workaround. A "deny delete" ACE blocks rename(2) on both sides, so the file
// cannot be replaced. It exists to protect the inode from exactly that, so
// clearing it to force the write through would defeat the protection being
// enforced — and would leave a window in which the file carried none.
func TestAtomicReplaceRefusesUndeletableTarget(t *testing.T) {
	if _, err := exec.LookPath("chmod"); err != nil {
		t.Skip("chmod(1) not available")
	}
	root, rootDir := newTestRoot(t)
	target := filepath.Join(rootDir, "guarded.txt")
	if err := os.WriteFile(target, []byte("protected"), 0o644); err != nil {
		t.Fatal(err)
	}
	if out, err := exec.Command("chmod", "+a", "everyone deny delete", target).CombinedOutput(); err != nil {
		t.Skipf("could not set a test ACL: %v (%s)", err, out)
	}
	t.Cleanup(func() { exec.Command("chmod", "-RN", rootDir).Run() })

	beforeACL := aclListing(t, target)

	err := AtomicReplace(root, "guarded.txt", []byte("overwritten"))
	if !errors.Is(err, errTargetUndeletable) {
		t.Fatalf("AtomicReplace = %v, want errTargetUndeletable", err)
	}

	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "protected" {
		t.Errorf("content = %q, want it unchanged", got)
	}
	if after := aclListing(t, target); after != beforeACL {
		t.Errorf("ACL changed by a refused write:\nbefore: %q\nafter:  %q", beforeACL, after)
	}
	if leftovers := tempLeftovers(t, rootDir); len(leftovers) > 0 {
		t.Errorf("temp files left behind: %v", leftovers)
	}
}

// TestAtomicReplaceWritePartwayFailureLeavesOriginalIntact is C6. RLIMIT_FSIZE
// forces the content write to fail partway through deterministically —
// SIGXFSZ is ignored so the process gets EFBIG back rather than being
// killed — without needing a filesystem that is actually out of space.
func TestAtomicReplaceWritePartwayFailureLeavesOriginalIntact(t *testing.T) {
	var old syscall.Rlimit
	if err := syscall.Getrlimit(syscall.RLIMIT_FSIZE, &old); err != nil {
		t.Skipf("cannot read RLIMIT_FSIZE: %v", err)
	}
	signal.Ignore(syscall.SIGXFSZ)
	t.Cleanup(func() { signal.Reset(syscall.SIGXFSZ) })

	root, rootDir := newTestRoot(t)
	target := filepath.Join(rootDir, "partial.txt")
	original := []byte("short")
	if err := os.WriteFile(target, original, 0o644); err != nil {
		t.Fatal(err)
	}

	limit := syscall.Rlimit{Cur: 20, Max: old.Max}
	if err := syscall.Setrlimit(syscall.RLIMIT_FSIZE, &limit); err != nil {
		t.Skipf("cannot lower RLIMIT_FSIZE: %v", err)
	}
	t.Cleanup(func() { syscall.Setrlimit(syscall.RLIMIT_FSIZE, &old) })

	newContent := []byte(strings.Repeat("x", 200)) // past the 20-byte cap
	err := AtomicReplace(root, "partial.txt", newContent)
	syscall.Setrlimit(syscall.RLIMIT_FSIZE, &old) // restore before any further I/O below
	if err == nil {
		t.Fatal("expected AtomicReplace to fail when the write exceeds RLIMIT_FSIZE")
	}
	if errors.Is(err, errAttrsUnpreservable) || errors.Is(err, errNotRegularFile) {
		t.Fatalf("failed for the wrong reason: %v", err)
	}

	got, rerr := os.ReadFile(target)
	if rerr != nil {
		t.Fatal(rerr)
	}
	if string(got) != string(original) {
		t.Errorf("target content = %q, want unchanged %q", got, original)
	}
	assertNoTempFiles(t, rootDir)
}

// TestAtomicReplaceConcurrentWritesNeverTear is C7: a reader racing writers
// must always see one whole write or the other, never a mix of the two —
// the rename AtomicReplace commits through is what rules out a torn read.
func TestAtomicReplaceConcurrentWritesNeverTear(t *testing.T) {
	root, rootDir := newTestRoot(t)
	target := filepath.Join(rootDir, "torn.txt")
	const size = 64 * 1024
	contentA := bytes.Repeat([]byte("A"), size)
	contentB := bytes.Repeat([]byte("B"), size)
	if err := os.WriteFile(target, contentA, 0o644); err != nil {
		t.Fatal(err)
	}

	stop := make(chan struct{})
	var readErr error
	var wg sync.WaitGroup

	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-stop:
				return
			default:
			}
			data, err := os.ReadFile(target)
			if err != nil {
				continue // a rename landed mid-read; retry
			}
			if !bytes.Equal(data, contentA) && !bytes.Equal(data, contentB) {
				readErr = fmt.Errorf("torn read: %d bytes, neither uniformly A nor uniformly B", len(data))
				return
			}
		}
	}()

	for i := 0; i < 50; i++ {
		content := contentA
		if i%2 == 1 {
			content = contentB
		}
		if err := AtomicReplace(root, "torn.txt", content); err != nil {
			t.Fatalf("AtomicReplace: %v", err)
		}
	}
	close(stop)
	wg.Wait()
	if readErr != nil {
		t.Error(readErr)
	}
}

// tempLeftovers reports any commit temp file that survived a failure path.
func tempLeftovers(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var found []string
	for _, e := range entries {
		if strings.Contains(e.Name(), "fsmcp-tmp") {
			found = append(found, e.Name())
		}
	}
	return found
}
