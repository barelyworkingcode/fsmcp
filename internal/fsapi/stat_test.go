package fsapi

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func callStat(t *testing.T, root *Root, path string) map[string]any {
	t.Helper()
	args, err := json.Marshal(statArgs{Path: path})
	if err != nil {
		t.Fatal(err)
	}
	result := handleStat(root, args)
	if len(result.Content) != 1 || result.Content[0].Type != "text" {
		t.Fatalf("unexpected content: %+v", result.Content)
	}
	var decoded map[string]any
	if err := json.Unmarshal([]byte(result.Content[0].Text), &decoded); err != nil {
		t.Fatalf("content not valid JSON: %v (%s)", err, result.Content[0].Text)
	}
	return decoded
}

func TestStatFile(t *testing.T) {
	root, _ := newTestRoot(t)
	decoded := callStat(t, root, "file.txt")

	if decoded["ok"] != true {
		t.Fatalf("ok = %v, want true (%v)", decoded["ok"], decoded)
	}
	if decoded["type"] != "file" {
		t.Errorf("type = %v, want file", decoded["type"])
	}
	if decoded["path"] != "file.txt" {
		t.Errorf("path = %v, want file.txt", decoded["path"])
	}
	if decoded["size"].(float64) != 5 { // "hello"
		t.Errorf("size = %v, want 5", decoded["size"])
	}
	sum := sha256.Sum256([]byte("hello"))
	want := hex.EncodeToString(sum[:])
	if decoded["sha256"] != want {
		t.Errorf("sha256 = %v, want %v", decoded["sha256"], want)
	}
	mtime, ok := decoded["mtime"].(string)
	if !ok {
		t.Fatalf("mtime is not a string: %v", decoded["mtime"])
	}
	if _, err := time.Parse(time.RFC3339, mtime); err != nil {
		t.Errorf("mtime %q does not parse as RFC3339: %v", mtime, err)
	}
	mode, ok := decoded["mode"].(string)
	if !ok || len(mode) != 4 {
		t.Errorf("mode = %v, want a 4-character octal string", decoded["mode"])
	}
}

func TestStatDirHasNoSHA256(t *testing.T) {
	root, _ := newTestRoot(t)
	decoded := callStat(t, root, "sub")

	if decoded["ok"] != true {
		t.Fatalf("ok = %v, want true", decoded["ok"])
	}
	if decoded["type"] != "dir" {
		t.Errorf("type = %v, want dir", decoded["type"])
	}
	if _, present := decoded["sha256"]; present {
		t.Errorf("dir result carries sha256: %v", decoded)
	}
}

func TestStatSymlinkReportsAsSymlink(t *testing.T) {
	root, _ := newTestRoot(t)
	decoded := callStat(t, root, "link-in")

	if decoded["ok"] != true {
		t.Fatalf("ok = %v, want true", decoded["ok"])
	}
	if decoded["type"] != "symlink" {
		t.Errorf("type = %v, want symlink", decoded["type"])
	}
	if _, present := decoded["sha256"]; present {
		t.Errorf("symlink result carries sha256: %v", decoded)
	}
}

func TestStatRootItself(t *testing.T) {
	root, _ := newTestRoot(t)
	for _, in := range []string{"", ".", "/"} {
		decoded := callStat(t, root, in)
		if decoded["ok"] != true {
			t.Fatalf("fs_stat(%q): ok = %v, want true", in, decoded["ok"])
		}
		if decoded["path"] != "." {
			t.Errorf("fs_stat(%q): path = %v, want \".\"", in, decoded["path"])
		}
		if decoded["type"] != "dir" {
			t.Errorf("fs_stat(%q): type = %v, want dir", in, decoded["type"])
		}
	}
}

func TestStatNotFound(t *testing.T) {
	root, _ := newTestRoot(t)
	decoded := callStat(t, root, "nope.txt")

	if decoded["ok"] != false {
		t.Fatalf("ok = %v, want false", decoded["ok"])
	}
	errObj, ok := decoded["error"].(map[string]any)
	if !ok {
		t.Fatalf("error field missing or malformed: %v", decoded)
	}
	if errObj["code"] != "not_found" {
		t.Errorf("code = %v, want not_found", errObj["code"])
	}
}

func TestStatDotDotEscapeRefused(t *testing.T) {
	root, _ := newTestRoot(t)
	decoded := callStat(t, root, "../../etc/passwd")

	if decoded["ok"] != false {
		t.Fatalf("ok = %v, want false", decoded["ok"])
	}
	errObj := decoded["error"].(map[string]any)
	if errObj["code"] != "outside_root" {
		t.Errorf("code = %v, want outside_root", errObj["code"])
	}
}

func TestStatLeadingSlashStaysInsideRoot(t *testing.T) {
	// DESIGN.md: a single leading '/' is stripped and the remainder is
	// looked up inside the root, not treated as a host-absolute path — so
	// "/etc/passwd" means "etc/passwd" under the root, which ordinarily
	// does not exist there.
	root, _ := newTestRoot(t)
	decoded := callStat(t, root, "/etc/passwd")

	if decoded["ok"] != false {
		t.Fatalf("ok = %v, want false", decoded["ok"])
	}
	errObj := decoded["error"].(map[string]any)
	if errObj["code"] != "not_found" {
		t.Errorf("code = %v, want not_found", errObj["code"])
	}
	if decoded["path"] == "/etc/passwd" {
		t.Errorf("path field retained the leading slash: %v", decoded["path"])
	}
}

func TestStatEscapeThroughSymlinkedDirRefused(t *testing.T) {
	root, _ := newTestRoot(t)
	decoded := callStat(t, root, "escape/secret.txt")

	if decoded["ok"] != false {
		t.Fatalf("ok = %v, want false", decoded["ok"])
	}
	errObj := decoded["error"].(map[string]any)
	if errObj["code"] != "outside_root" {
		t.Errorf("code = %v, want outside_root", errObj["code"])
	}
}

func TestStatNulByteRefused(t *testing.T) {
	root, _ := newTestRoot(t)
	decoded := callStat(t, root, "notes/\x00x.md")

	if decoded["ok"] != false {
		t.Fatalf("ok = %v, want false", decoded["ok"])
	}
	errObj := decoded["error"].(map[string]any)
	if errObj["code"] != "invalid_argument" {
		t.Errorf("code = %v, want invalid_argument", errObj["code"])
	}
}

func TestStatMalformedArguments(t *testing.T) {
	root, _ := newTestRoot(t)
	result := handleStat(root, json.RawMessage(`not json`))
	if !result.IsError {
		t.Fatal("expected an error result for malformed arguments")
	}
	var decoded map[string]any
	if err := json.Unmarshal([]byte(result.Content[0].Text), &decoded); err != nil {
		t.Fatalf("content not valid JSON: %v", err)
	}
	errObj := decoded["error"].(map[string]any)
	if errObj["code"] != "invalid_argument" {
		t.Errorf("code = %v, want invalid_argument", errObj["code"])
	}
}

// TestNoRootPathLeak is the acceptance test DESIGN.md's error-mapping rule
// demands: run several operations that fail in different ways and assert
// the root's absolute host path — and its parent, and the sibling directory
// a symlink escapes to — appears in NO emitted byte, across every result.
func TestNoRootPathLeak(t *testing.T) {
	root, rootDir := newTestRoot(t)
	base := filepath.Dir(rootDir)
	outsideDir := filepath.Join(base, "outside")

	failingCalls := []string{
		"../../etc/passwd",
		"/etc/passwd",
		"escape/secret.txt",
		"nope.txt",
		"file.txt/x", // not a directory
		"notes/\x00x.md",
		strings.Repeat("../", 20) + "etc/passwd",
	}

	var all strings.Builder
	for _, p := range failingCalls {
		args, err := json.Marshal(statArgs{Path: p})
		if err != nil {
			t.Fatal(err)
		}
		result := handleStat(root, args)
		if !result.IsError {
			t.Fatalf("fs_stat(%q) unexpectedly succeeded: %+v", p, result)
		}
		for _, c := range result.Content {
			all.WriteString(c.Text)
			all.WriteByte('\n')
		}
	}

	// Also exercise a malformed-arguments failure and a bad tool name
	// through the registry, since those are refusals too.
	reg := NewRegistry(root, false)
	RegisterStat(reg)
	badArgs := reg.Call("fs_stat", json.RawMessage(`{`), nil)
	for _, c := range badArgs.Content {
		all.WriteString(c.Text)
	}
	unknownTool := reg.Call("fs_delete", json.RawMessage(`{}`), nil)
	for _, c := range unknownTool.Content {
		all.WriteString(c.Text)
	}

	output := all.String()
	for _, secret := range []string{rootDir, base, outsideDir} {
		if strings.Contains(output, secret) {
			t.Errorf("emitted output contains a host path %q:\n%s", secret, output)
		}
	}
}

// Sanity check that the fixture actually built what the leak test assumes.
func TestFixtureSanity(t *testing.T) {
	_, rootDir := newTestRoot(t)
	if _, err := os.Stat(rootDir); err != nil {
		t.Fatalf("fixture root missing: %v", err)
	}
}
