package fsapi

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"fsmcp/internal/proto"
)

func TestNormalizePath(t *testing.T) {
	cases := []struct {
		name    string
		in      string
		want    string
		wantErr bool
	}{
		{"empty is root", "", ".", false},
		{"dot is root", ".", ".", false},
		{"bare slash is root", "/", ".", false},
		{"leading slash stripped", "/notes/x.md", "notes/x.md", false},
		{"already relative", "notes/x.md", "notes/x.md", false},
		{"leading dot-slash stripped", "./notes/x.md", "notes/x.md", false},
		{"repeated leading dot-slash stripped", "././notes/x.md", "notes/x.md", false},
		{"only one leading slash stripped", "//notes/x.md", "/notes/x.md", false},
		{"dotdot is passed through untouched", "notes/../x.md", "notes/../x.md", false},
		{"leading dotdot is passed through untouched", "../x.md", "../x.md", false},
		{"NUL byte rejected", "notes/\x00x.md", "", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := NormalizePath(tc.in)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("NormalizePath(%q) = %q, nil; want error", tc.in, got)
				}
				if !errors.Is(err, ErrInvalidPath) {
					t.Errorf("NormalizePath(%q) error = %v, want ErrInvalidPath", tc.in, err)
				}
				return
			}
			if err != nil {
				t.Fatalf("NormalizePath(%q) unexpected error: %v", tc.in, err)
			}
			if got != tc.want {
				t.Errorf("NormalizePath(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

// newTestRoot builds a root directory with a regular file, a subdirectory,
// a symlink pointing inside the root, and an out-of-root sibling directory
// linked from inside the root — the shapes the containment tests need.
func newTestRoot(t *testing.T) (root *Root, rootDir string) {
	t.Helper()
	base := t.TempDir()
	rootDir = filepath.Join(base, "root")
	if err := os.Mkdir(rootDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(rootDir, "file.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(rootDir, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}

	outsideDir := filepath.Join(base, "outside")
	if err := os.Mkdir(outsideDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(outsideDir, "secret.txt"), []byte("secret"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outsideDir, filepath.Join(rootDir, "escape")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(rootDir, "file.txt"), filepath.Join(rootDir, "link-in")); err != nil {
		t.Fatal(err)
	}
	// A genuinely relative symlink staying inside the root (A8a) — distinct
	// from "link-in" above, whose target is stored as an absolute path and
	// so is refused under A8b instead, whatever it points at.
	if err := os.Symlink("file.txt", filepath.Join(rootDir, "rel-link-in")); err != nil {
		t.Fatal(err)
	}
	// Relative symlinks escaping the root (A3/A4/A5): the escape is via a
	// ".." component in the link's own target, not via an absolute path.
	if err := os.Symlink("../outside/secret.txt", filepath.Join(rootDir, "rel-link-out-file")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("../outside/nonexistent.txt", filepath.Join(rootDir, "rel-link-out-dangling")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("../outside", filepath.Join(rootDir, "rel-link-out-dir")); err != nil {
		t.Fatal(err)
	}
	// A symlink cycle (A6): resolving either name must refuse promptly,
	// never hang.
	if err := os.Symlink("cycle-b", filepath.Join(rootDir, "cycle-a")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("cycle-a", filepath.Join(rootDir, "cycle-b")); err != nil {
		t.Fatal(err)
	}

	r, err := OpenRoot(rootDir)
	if err != nil {
		t.Fatalf("OpenRoot: %v", err)
	}
	t.Cleanup(func() { r.Close() })
	return r, rootDir
}

func TestRootLstatOrdinaryFile(t *testing.T) {
	root, _ := newTestRoot(t)
	fi, err := root.Lstat("file.txt")
	if err != nil {
		t.Fatalf("Lstat: %v", err)
	}
	if fi.IsDir() {
		t.Error("file.txt reported as a directory")
	}
}

func TestRootLstatSymlinkInsideRoot(t *testing.T) {
	root, _ := newTestRoot(t)
	fi, err := root.Lstat("link-in")
	if err != nil {
		t.Fatalf("Lstat: %v", err)
	}
	if fi.Mode()&os.ModeSymlink == 0 {
		t.Error("link-in not reported as a symlink")
	}
}

func TestRootRefusesEscapeThroughSymlinkedDir(t *testing.T) {
	root, _ := newTestRoot(t)
	_, err := root.Lstat("escape/secret.txt")
	if err == nil {
		t.Fatal("expected an error resolving through a symlink that escapes the root")
	}
	code, _ := MapError(err)
	if code != proto.ErrOutsideRoot {
		t.Errorf("MapError code = %q, want %q (err: %v)", code, proto.ErrOutsideRoot, err)
	}
}

func TestRootRefusesDotDotEscape(t *testing.T) {
	root, _ := newTestRoot(t)
	_, err := root.Lstat("../outside/secret.txt")
	if err == nil {
		t.Fatal("expected an error for a path escaping via '..'")
	}
	code, _ := MapError(err)
	if code != proto.ErrOutsideRoot {
		t.Errorf("MapError code = %q, want %q (err: %v)", code, proto.ErrOutsideRoot, err)
	}
}

func TestMapError(t *testing.T) {
	root, _ := newTestRoot(t)

	_, notExistErr := root.Lstat("nope.txt")
	_, notDirErr := root.Lstat("file.txt/x")

	cases := []struct {
		name string
		err  error
		want proto.ErrorCode
	}{
		{"nil", nil, ""},
		{"malformed path sentinel", ErrInvalidPath, proto.ErrInvalidArgument},
		{"not exist", notExistErr, proto.ErrNotFound},
		{"not a directory", notDirErr, proto.ErrNotADir},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if tc.err == nil && tc.name != "nil" {
				t.Skip("could not produce this error on this platform")
			}
			code, msg := MapError(tc.err)
			if code != tc.want {
				t.Errorf("MapError(%v) code = %q, want %q", tc.err, code, tc.want)
			}
			if tc.err != nil && msg == "" {
				t.Errorf("MapError(%v) message is empty", tc.err)
			}
		})
	}
}

// TestRootFollowsRelativeSymlinkInsideRoot is A8a: a relative symlink whose
// target stays inside the root must resolve normally, not be over-refused
// the way an absolute one is.
func TestRootFollowsRelativeSymlinkInsideRoot(t *testing.T) {
	root, _ := newTestRoot(t)
	fi, err := root.Stat("rel-link-in")
	if err != nil {
		t.Fatalf("Stat(rel-link-in): %v", err)
	}
	if fi.IsDir() {
		t.Error("rel-link-in resolved to a directory")
	}
	data, err := root.ReadFile("rel-link-in")
	if err != nil {
		t.Fatalf("ReadFile(rel-link-in): %v", err)
	}
	if string(data) != "hello" {
		t.Errorf("content via rel-link-in = %q, want %q", data, "hello")
	}
}

// TestRootRefusesAbsoluteSymlinkEvenPointingInside is A8b: os.Root refuses
// to traverse an absolute symlink whatever it points at, including a
// target that is inside the root. This is a deliberate limitation, pinned
// so it does not quietly become "fixed" — see DESIGN.md.
func TestRootRefusesAbsoluteSymlinkEvenPointingInside(t *testing.T) {
	root, _ := newTestRoot(t)
	_, err := root.Stat("link-in")
	if err == nil {
		t.Fatal("expected an error resolving an absolute symlink, even one pointing inside the root")
	}
	code, _ := MapError(err)
	if code != proto.ErrOutsideRoot {
		t.Errorf("MapError code = %q, want %q (err: %v)", code, proto.ErrOutsideRoot, err)
	}
}

// TestRootRefusesRelativeSymlinkEscapingToFile is A3: a symlink inside the
// root whose (relative) target is a file outside it, and the target exists.
func TestRootRefusesRelativeSymlinkEscapingToFile(t *testing.T) {
	root, _ := newTestRoot(t)
	_, err := root.Stat("rel-link-out-file")
	if err == nil {
		t.Fatal("expected an error resolving a symlink escaping to an outside file")
	}
	code, _ := MapError(err)
	if code != proto.ErrOutsideRoot {
		t.Errorf("MapError code = %q, want %q (err: %v)", code, proto.ErrOutsideRoot, err)
	}
}

// TestRootRefusesRelativeSymlinkEscapingDangling is A4: same as A3, but the
// target does not exist. Non-existence must not change the refusal — the
// containment check happens during path resolution, before anything asks
// whether the endpoint exists.
func TestRootRefusesRelativeSymlinkEscapingDangling(t *testing.T) {
	root, _ := newTestRoot(t)
	_, err := root.Stat("rel-link-out-dangling")
	if err == nil {
		t.Fatal("expected an error resolving a dangling symlink escaping the root")
	}
	code, _ := MapError(err)
	if code != proto.ErrOutsideRoot {
		t.Errorf("MapError code = %q, want %q (err: %v)", code, proto.ErrOutsideRoot, err)
	}
}

// TestRootRefusesRelativeSymlinkEscapingToDirectory is A5: same shape, but
// the outside target is a directory, and the escape is exercised by
// resolving a path through it, not just the link itself.
func TestRootRefusesRelativeSymlinkEscapingToDirectory(t *testing.T) {
	root, _ := newTestRoot(t)
	_, err := root.Lstat("rel-link-out-dir/secret.txt")
	if err == nil {
		t.Fatal("expected an error resolving through a symlink to an outside directory")
	}
	code, _ := MapError(err)
	if code != proto.ErrOutsideRoot {
		t.Errorf("MapError code = %q, want %q (err: %v)", code, proto.ErrOutsideRoot, err)
	}
}

// TestRootRefusesSymlinkCycleWithoutHanging is A6: resolving a symlink
// cycle must be refused promptly, never hang the (single-threaded) server.
func TestRootRefusesSymlinkCycleWithoutHanging(t *testing.T) {
	root, _ := newTestRoot(t)
	done := make(chan error, 1)
	go func() {
		_, err := root.Stat("cycle-a")
		done <- err
	}()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("expected an error resolving a symlink cycle")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("resolving a symlink cycle hung")
	}
}

// TestNoRootPathLeakAllTools is the full A10 battery: every tool, wired up
// exactly as main.go wires it, called with arguments chosen to make each
// fail in several distinct ways. The root's absolute path, its parent, and
// the sibling directory a symlink escapes to must appear in no emitted
// byte from any of them.
func TestNoRootPathLeakAllTools(t *testing.T) {
	root, rootDir := newTestRoot(t)
	base := filepath.Dir(rootDir)
	outsideDir := filepath.Join(base, "outside")

	reg := NewRegistry(root, false)
	RegisterStat(reg)
	RegisterList(reg)
	RegisterRead(reg)
	RegisterGlob(reg)
	RegisterGrep(reg)
	RegisterWrite(reg)
	RegisterReplace(reg)
	RegisterMkdir(reg)
	RegisterMove(reg)
	RegisterDelete(reg)

	zeroHash := strings.Repeat("0", 64)
	calls := []struct {
		tool string
		args string
	}{
		{"fs_stat", `{"path":"../../etc/passwd"}`},
		{"fs_stat", `{"path":"escape/secret.txt"}`},
		{"fs_stat", `{"path":"notes/\u0000x.md"}`},
		{"fs_list", `{"path":"../outside"}`},
		{"fs_list", `{"path":"escape"}`},
		{"fs_read", `{"path":"../outside/secret.txt"}`},
		{"fs_read", `{"path":"sub"}`},
		{"fs_glob", `{"pattern":"/etc/passwd"}`},
		{"fs_glob", `{"pattern":"../*"}`},
		{"fs_grep", `{"pattern":"x","glob":"/etc/*"}`},
		{"fs_grep", `{"pattern":"x","path":"../outside"}`},
		{"fs_write", `{"path":"../outside/evil.txt","content":"x","if_sha256":null}`},
		{"fs_write", `{"path":"file.txt","content":"x","if_sha256":"` + zeroHash + `"}`},
		{"fs_replace", `{"path":"../outside/secret.txt","if_sha256":null,"edits":[{"find":"a","replace":"b"}]}`},
		{"fs_mkdir", `{"path":"../outside/newdir"}`},
		{"fs_move", `{"source":"../outside/secret.txt","destination":"stolen.txt"}`},
		{"fs_move", `{"source":"file.txt","destination":"file.txt"}`},
		{"fs_delete", `{"path":"."}`},
		{"fs_delete", `{"path":"../outside/secret.txt"}`},
	}

	var all strings.Builder
	for _, c := range calls {
		result := reg.Call(c.tool, json.RawMessage(c.args), nil)
		for _, block := range result.Content {
			all.WriteString(block.Text)
			all.WriteByte('\n')
		}
	}

	output := all.String()
	for _, secret := range []string{rootDir, base, outsideDir} {
		if strings.Contains(output, secret) {
			t.Errorf("emitted output contains a host path %q:\n%s", secret, output)
		}
	}
}
