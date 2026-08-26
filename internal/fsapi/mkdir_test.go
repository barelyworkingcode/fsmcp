package fsapi

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func callMkdir(t *testing.T, root *Root, path string) map[string]any {
	t.Helper()
	raw, err := json.Marshal(mkdirArgs{Path: path})
	if err != nil {
		t.Fatal(err)
	}
	result := handleMkdir(root, raw)
	var decoded map[string]any
	if err := json.Unmarshal([]byte(result.Content[0].Text), &decoded); err != nil {
		t.Fatalf("content not valid JSON: %v (%s)", err, result.Content[0].Text)
	}
	return decoded
}

func TestMkdirSingleLevel(t *testing.T) {
	root, rootDir := newTestRoot(t)
	decoded := callMkdir(t, root, "newdir")
	if decoded["ok"] != true {
		t.Fatalf("ok = %v, want true (%v)", decoded["ok"], decoded)
	}
	created := decoded["created"].([]any)
	if len(created) != 1 || created[0] != "newdir" {
		t.Errorf("created = %v, want [newdir]", decoded["created"])
	}
	fi, err := os.Stat(filepath.Join(rootDir, "newdir"))
	if err != nil || !fi.IsDir() {
		t.Fatalf("newdir was not created: %v", err)
	}
}

func TestMkdirRecursiveCreatesMissingParents(t *testing.T) {
	root, rootDir := newTestRoot(t)
	decoded := callMkdir(t, root, "a/b/c")
	if decoded["ok"] != true {
		t.Fatalf("ok = %v, want true (%v)", decoded["ok"], decoded)
	}
	created := decoded["created"].([]any)
	want := []string{"a", "a/b", "a/b/c"}
	if len(created) != len(want) {
		t.Fatalf("created = %v, want %v", created, want)
	}
	for i, w := range want {
		if created[i] != w {
			t.Errorf("created[%d] = %v, want %v", i, created[i], w)
		}
	}
	fi, err := os.Stat(filepath.Join(rootDir, "a/b/c"))
	if err != nil || !fi.IsDir() {
		t.Fatalf("a/b/c was not created: %v", err)
	}
}

func TestMkdirAlreadyExistingParentsNotRepeated(t *testing.T) {
	root, _ := newTestRoot(t)
	// "sub" already exists in the fixture.
	decoded := callMkdir(t, root, "sub/nested")
	if decoded["ok"] != true {
		t.Fatalf("ok = %v, want true (%v)", decoded["ok"], decoded)
	}
	created := decoded["created"].([]any)
	if len(created) != 1 || created[0] != "sub/nested" {
		t.Errorf("created = %v, want [sub/nested] (sub already existed)", decoded["created"])
	}
}

func TestMkdirRootIsANoOpSuccess(t *testing.T) {
	root, _ := newTestRoot(t)
	for _, in := range []string{"", ".", "/"} {
		decoded := callMkdir(t, root, in)
		if decoded["ok"] != true {
			t.Fatalf("fs_mkdir(%q): ok = %v, want true", in, decoded["ok"])
		}
		created := decoded["created"].([]any)
		if len(created) != 0 {
			t.Errorf("fs_mkdir(%q): created = %v, want []", in, created)
		}
	}
}

func TestMkdirBlockedByExistingFile(t *testing.T) {
	root, _ := newTestRoot(t)
	// "file.txt" already exists as a regular file in the fixture.
	decoded := callMkdir(t, root, "file.txt/sub")
	if decoded["ok"] != false {
		t.Fatalf("ok = %v, want false", decoded["ok"])
	}
	errObj := decoded["error"].(map[string]any)
	if errObj["code"] != "not_a_dir" {
		t.Errorf("code = %v, want not_a_dir", errObj["code"])
	}
}

func TestMkdirOutsideRootRefused(t *testing.T) {
	root, _ := newTestRoot(t)
	decoded := callMkdir(t, root, "../outside/newdir")
	if decoded["ok"] != false {
		t.Fatalf("ok = %v, want false", decoded["ok"])
	}
	errObj := decoded["error"].(map[string]any)
	if errObj["code"] != "outside_root" {
		t.Errorf("code = %v, want outside_root", errObj["code"])
	}
}

func TestMkdirNulByteRefused(t *testing.T) {
	root, _ := newTestRoot(t)
	decoded := callMkdir(t, root, "notes/\x00x")
	errObj := decoded["error"]
	if decoded["ok"] != false || errObj == nil {
		t.Fatalf("ok = %v, want false", decoded["ok"])
	}
	if decoded["error"].(map[string]any)["code"] != "invalid_argument" {
		t.Errorf("code = %v, want invalid_argument", decoded["error"])
	}
}
