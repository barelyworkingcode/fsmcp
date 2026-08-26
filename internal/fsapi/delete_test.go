package fsapi

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func deleteArgsJSON(t *testing.T, path string, recursive bool, hash string) json.RawMessage {
	t.Helper()
	m := map[string]any{"path": path}
	if recursive {
		m["recursive"] = true
	}
	if hash != "" {
		m["if_sha256"] = hash
	}
	raw, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func callDelete(t *testing.T, root *Root, path string, recursive bool, hash string) map[string]any {
	t.Helper()
	result := handleDelete(root, deleteArgsJSON(t, path, recursive, hash))
	var decoded map[string]any
	if err := json.Unmarshal([]byte(result.Content[0].Text), &decoded); err != nil {
		t.Fatalf("content not valid JSON: %v (%s)", err, result.Content[0].Text)
	}
	return decoded
}

func TestDeleteRegularFile(t *testing.T) {
	root, rootDir := newTestRoot(t)
	decoded := callDelete(t, root, "file.txt", false, "")
	if decoded["ok"] != true {
		t.Fatalf("ok = %v, want true (%v)", decoded["ok"], decoded)
	}
	if _, err := os.Stat(filepath.Join(rootDir, "file.txt")); !os.IsNotExist(err) {
		t.Errorf("file.txt still present: err=%v", err)
	}
}

// TestDeleteRootRefused is G1.
func TestDeleteRootRefused(t *testing.T) {
	root, _ := newTestRoot(t)
	for _, in := range []string{"", ".", "/"} {
		decoded := callDelete(t, root, in, true, "")
		errObj, ok := decoded["error"].(map[string]any)
		if decoded["ok"] != false || !ok {
			t.Fatalf("fs_delete(%q) = %v, want a refusal", in, decoded)
		}
		if errObj["code"] != "invalid_argument" {
			t.Errorf("fs_delete(%q) code = %v, want invalid_argument", in, errObj["code"])
		}
	}
}

// TestDeleteNonEmptyDirWithoutRecursiveRefused is G2.
func TestDeleteNonEmptyDirWithoutRecursiveRefused(t *testing.T) {
	root, rootDir := newTestRoot(t)
	if err := os.WriteFile(filepath.Join(rootDir, "sub", "inside.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	decoded := callDelete(t, root, "sub", false, "")
	if decoded["ok"] != false {
		t.Fatalf("ok = %v, want false (%v)", decoded["ok"], decoded)
	}
	if _, err := os.Stat(filepath.Join(rootDir, "sub")); err != nil {
		t.Errorf("sub removed despite refusal: %v", err)
	}
}

func TestDeleteEmptyDirWithoutRecursiveSucceeds(t *testing.T) {
	root, rootDir := newTestRoot(t)
	empty := filepath.Join(rootDir, "empty")
	if err := os.Mkdir(empty, 0o755); err != nil {
		t.Fatal(err)
	}
	decoded := callDelete(t, root, "empty", false, "")
	if decoded["ok"] != true {
		t.Fatalf("ok = %v, want true (%v)", decoded["ok"], decoded)
	}
	if _, err := os.Stat(empty); !os.IsNotExist(err) {
		t.Errorf("empty dir still present: err=%v", err)
	}
}

func TestDeleteNonEmptyDirWithRecursiveSucceeds(t *testing.T) {
	root, rootDir := newTestRoot(t)
	if err := os.WriteFile(filepath.Join(rootDir, "sub", "nested.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	decoded := callDelete(t, root, "sub", true, "")
	if decoded["ok"] != true {
		t.Fatalf("ok = %v, want true (%v)", decoded["ok"], decoded)
	}
	if _, err := os.Stat(filepath.Join(rootDir, "sub")); !os.IsNotExist(err) {
		t.Errorf("sub still present: err=%v", err)
	}
}

// TestDeleteRecursiveUnlinksSymlinkWithoutDescending is G3: a recursive
// delete over a directory containing a symlink to somewhere outside the
// root must unlink the symlink itself, and must never touch what it
// points to.
func TestDeleteRecursiveUnlinksSymlinkWithoutDescending(t *testing.T) {
	root, rootDir := newTestRoot(t)
	base := filepath.Dir(rootDir)
	outsideDir := filepath.Join(base, "canary")
	if err := os.Mkdir(outsideDir, 0o755); err != nil {
		t.Fatal(err)
	}
	canaryFile := filepath.Join(outsideDir, "canary.txt")
	if err := os.WriteFile(canaryFile, []byte("do not touch"), 0o644); err != nil {
		t.Fatal(err)
	}

	victim := filepath.Join(rootDir, "sub", "escape-link")
	if err := os.Symlink(outsideDir, victim); err != nil {
		t.Fatal(err)
	}

	decoded := callDelete(t, root, "sub", true, "")
	if decoded["ok"] != true {
		t.Fatalf("ok = %v, want true (%v)", decoded["ok"], decoded)
	}

	if _, err := os.Lstat(victim); !os.IsNotExist(err) {
		t.Errorf("symlink still present after recursive delete: err=%v", err)
	}
	got, err := os.ReadFile(canaryFile)
	if err != nil {
		t.Fatalf("canary file outside the root was removed or is unreadable: %v", err)
	}
	if string(got) != "do not touch" {
		t.Errorf("canary file content changed: %q", got)
	}
}

func TestDeleteSymlinkItselfUnlinked(t *testing.T) {
	root, rootDir := newTestRoot(t)
	base := filepath.Dir(rootDir)
	outsideFile := filepath.Join(base, "canary.txt")
	if err := os.WriteFile(outsideFile, []byte("safe"), 0o644); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(rootDir, "link-to-outside")
	if err := os.Symlink(outsideFile, link); err != nil {
		t.Fatal(err)
	}

	decoded := callDelete(t, root, "link-to-outside", false, "")
	if decoded["ok"] != true {
		t.Fatalf("ok = %v, want true (%v)", decoded["ok"], decoded)
	}
	if _, err := os.Lstat(link); !os.IsNotExist(err) {
		t.Errorf("symlink still present: err=%v", err)
	}
	got, err := os.ReadFile(outsideFile)
	if err != nil || string(got) != "safe" {
		t.Errorf("target content changed: %q, err=%v", got, err)
	}
}

// TestDeleteHashMismatchRefused is G4.
func TestDeleteHashMismatchRefused(t *testing.T) {
	root, rootDir := newTestRoot(t)
	wrong := sha256Hex(t, []byte("not the content"))
	decoded := callDelete(t, root, "file.txt", false, wrong)
	if decoded["ok"] != false {
		t.Fatalf("ok = %v, want false (%v)", decoded["ok"], decoded)
	}
	errObj := decoded["error"].(map[string]any)
	if errObj["code"] != "precondition_failed" {
		t.Errorf("code = %v, want precondition_failed", errObj["code"])
	}
	if _, err := os.Stat(filepath.Join(rootDir, "file.txt")); err != nil {
		t.Errorf("file removed despite precondition failure: %v", err)
	}
}

func TestDeleteHashMatchSucceeds(t *testing.T) {
	root, _ := newTestRoot(t)
	hash := sha256Hex(t, []byte("hello"))
	decoded := callDelete(t, root, "file.txt", false, hash)
	if decoded["ok"] != true {
		t.Fatalf("ok = %v, want true (%v)", decoded["ok"], decoded)
	}
}

func TestDeleteMalformedHashRefused(t *testing.T) {
	root, _ := newTestRoot(t)
	decoded := callDelete(t, root, "file.txt", false, "not-a-hash")
	errObj, ok := decoded["error"].(map[string]any)
	if decoded["ok"] != false || !ok || errObj["code"] != "invalid_argument" {
		t.Fatalf("decoded = %v, want invalid_argument", decoded)
	}
}

func TestDeleteNonexistentPathRefused(t *testing.T) {
	root, _ := newTestRoot(t)
	decoded := callDelete(t, root, "nope.txt", false, "")
	errObj, ok := decoded["error"].(map[string]any)
	if decoded["ok"] != false || !ok || errObj["code"] != "not_found" {
		t.Fatalf("decoded = %v, want not_found", decoded)
	}
}

func TestDeleteOutsideRootRefused(t *testing.T) {
	root, _ := newTestRoot(t)
	decoded := callDelete(t, root, "../outside/secret.txt", false, "")
	errObj, ok := decoded["error"].(map[string]any)
	if decoded["ok"] != false || !ok || errObj["code"] != "outside_root" {
		t.Fatalf("decoded = %v, want outside_root", decoded)
	}
}
