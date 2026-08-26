package fsapi

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func callList(t *testing.T, root *Root, path string) map[string]any {
	t.Helper()
	args, err := json.Marshal(listArgs{Path: path})
	if err != nil {
		t.Fatal(err)
	}
	result := handleList(root, args)
	if len(result.Content) != 1 || result.Content[0].Type != "text" {
		t.Fatalf("unexpected content: %+v", result.Content)
	}
	var decoded map[string]any
	if err := json.Unmarshal([]byte(result.Content[0].Text), &decoded); err != nil {
		t.Fatalf("content not valid JSON: %v (%s)", err, result.Content[0].Text)
	}
	return decoded
}

func TestListRootDirectory(t *testing.T) {
	root, _ := newTestRoot(t)
	decoded := callList(t, root, ".")

	if decoded["ok"] != true {
		t.Fatalf("ok = %v, want true (%v)", decoded["ok"], decoded)
	}
	if decoded["path"] != "." {
		t.Errorf("path = %v, want \".\"", decoded["path"])
	}
	entries, ok := decoded["entries"].([]any)
	if !ok {
		t.Fatalf("entries missing or wrong shape: %v", decoded)
	}

	names := map[string]map[string]any{}
	for _, e := range entries {
		em := e.(map[string]any)
		names[em["name"].(string)] = em
	}

	fileEntry, ok := names["file.txt"]
	if !ok {
		t.Fatalf("file.txt missing from listing: %v", names)
	}
	if fileEntry["type"] != "file" {
		t.Errorf("file.txt type = %v, want file", fileEntry["type"])
	}
	if fileEntry["size"].(float64) != 5 {
		t.Errorf("file.txt size = %v, want 5", fileEntry["size"])
	}
	if _, present := fileEntry["sha256"]; present {
		t.Errorf("fs_list entry carries sha256: %v", fileEntry)
	}

	subEntry, ok := names["sub"]
	if !ok {
		t.Fatalf("sub missing from listing: %v", names)
	}
	if subEntry["type"] != "dir" {
		t.Errorf("sub type = %v, want dir", subEntry["type"])
	}

	linkEntry, ok := names["link-in"]
	if !ok {
		t.Fatalf("link-in missing from listing: %v", names)
	}
	if linkEntry["type"] != "symlink" {
		t.Errorf("link-in type = %v, want symlink", linkEntry["type"])
	}
	if linkEntry["size"].(float64) != 0 {
		t.Errorf("link-in size = %v, want 0", linkEntry["size"])
	}

	// Only the escaping symlink's own name is disclosed, never its target.
	escapeEntry, ok := names["escape"]
	if !ok {
		t.Fatalf("escape missing from listing: %v", names)
	}
	if escapeEntry["type"] != "symlink" {
		t.Errorf("escape type = %v, want symlink", escapeEntry["type"])
	}

	if decoded["truncated"] != false {
		t.Errorf("truncated = %v, want false", decoded["truncated"])
	}
}

func TestListSubdirectory(t *testing.T) {
	root, rootDir := newTestRoot(t)
	if err := os.WriteFile(filepath.Join(rootDir, "sub", "nested.txt"), []byte("hi"), 0o644); err != nil {
		t.Fatal(err)
	}

	decoded := callList(t, root, "sub")
	if decoded["ok"] != true {
		t.Fatalf("ok = %v, want true", decoded["ok"])
	}
	if decoded["path"] != "sub" {
		t.Errorf("path = %v, want sub", decoded["path"])
	}
	entries := decoded["entries"].([]any)
	if len(entries) != 1 {
		t.Fatalf("entries = %v, want exactly nested.txt", entries)
	}
	entry := entries[0].(map[string]any)
	if entry["name"] != "nested.txt" {
		t.Errorf("name = %v, want bare filename nested.txt", entry["name"])
	}
}

func TestListEmptyDirectory(t *testing.T) {
	root, rootDir := newTestRoot(t)
	if err := os.Mkdir(filepath.Join(rootDir, "empty"), 0o755); err != nil {
		t.Fatal(err)
	}

	decoded := callList(t, root, "empty")
	if decoded["ok"] != true {
		t.Fatalf("ok = %v, want true", decoded["ok"])
	}
	entries, ok := decoded["entries"].([]any)
	if !ok {
		t.Fatalf("entries missing or wrong shape: %v", decoded)
	}
	if len(entries) != 0 {
		t.Errorf("entries = %v, want empty", entries)
	}
}

func TestListRefusesFile(t *testing.T) {
	root, _ := newTestRoot(t)
	decoded := callList(t, root, "file.txt")

	if decoded["ok"] != false {
		t.Fatalf("ok = %v, want false", decoded["ok"])
	}
	errObj := decoded["error"].(map[string]any)
	if errObj["code"] != "not_a_dir" {
		t.Errorf("code = %v, want not_a_dir", errObj["code"])
	}
}

func TestListNotFound(t *testing.T) {
	root, _ := newTestRoot(t)
	decoded := callList(t, root, "nope")

	if decoded["ok"] != false {
		t.Fatalf("ok = %v, want false", decoded["ok"])
	}
	errObj := decoded["error"].(map[string]any)
	if errObj["code"] != "not_found" {
		t.Errorf("code = %v, want not_found", errObj["code"])
	}
}

func TestListEscapingSymlinkRefused(t *testing.T) {
	root, _ := newTestRoot(t)
	decoded := callList(t, root, "escape")

	if decoded["ok"] != false {
		t.Fatalf("ok = %v, want false", decoded["ok"])
	}
	errObj := decoded["error"].(map[string]any)
	if errObj["code"] != "outside_root" {
		t.Errorf("code = %v, want outside_root", errObj["code"])
	}
}

func TestListDotDotEscapeRefused(t *testing.T) {
	root, _ := newTestRoot(t)
	decoded := callList(t, root, "../../etc")

	if decoded["ok"] != false {
		t.Fatalf("ok = %v, want false", decoded["ok"])
	}
	errObj := decoded["error"].(map[string]any)
	if errObj["code"] != "outside_root" {
		t.Errorf("code = %v, want outside_root", errObj["code"])
	}
}

func TestListHostileFilenamesComeBackIntact(t *testing.T) {
	root, rootDir := newTestRoot(t)
	weird := map[string]string{
		"we\nird.txt":  "newline named",
		"ta\tb.txt":    "tab named",
		"qu\"ote.txt":  "quote named",
		"back\\sl.txt": "backslash named",
	}
	if err := os.Mkdir(filepath.Join(rootDir, "weird"), 0o755); err != nil {
		t.Fatal(err)
	}
	for name, content := range weird {
		if err := os.WriteFile(filepath.Join(rootDir, "weird", name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	decoded := callList(t, root, "weird")
	if decoded["ok"] != true {
		t.Fatalf("ok = %v, want true (%v)", decoded["ok"], decoded)
	}
	entries := decoded["entries"].([]any)
	if len(entries) != len(weird) {
		t.Fatalf("entries = %d, want %d: %v", len(entries), len(weird), entries)
	}
	got := map[string]bool{}
	for _, e := range entries {
		got[e.(map[string]any)["name"].(string)] = true
	}
	for name := range weird {
		if !got[name] {
			t.Errorf("missing entry for hostile filename %q; got %v", name, got)
		}
	}
}

// TestListTruncationIsHonest exercises the byte-budget bound directly with a
// tiny budget, rather than building a directory large enough to hit the real
// 8 MiB default.
func TestListTruncationIsHonest(t *testing.T) {
	root, rootDir := newTestRoot(t)
	if err := os.Mkdir(filepath.Join(rootDir, "many"), 0o755); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 20; i++ {
		name := "f" + string(rune('a'+i)) + ".txt"
		if err := os.WriteFile(filepath.Join(rootDir, "many", name), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	result, err := listDirectory(root, "many", 100)
	if err != nil {
		t.Fatalf("listDirectory: %v", err)
	}
	if !result.Truncated {
		t.Fatal("expected truncated = true with a 100-byte budget over 20 entries")
	}
	if len(result.Entries) == 0 {
		t.Fatal("expected at least one entry before truncating")
	}
	if len(result.Entries) >= 20 {
		t.Fatalf("expected fewer than all 20 entries, got %d", len(result.Entries))
	}

	full, err := listDirectory(root, "many", DefaultMaxResponseBytes)
	if err != nil {
		t.Fatalf("listDirectory (full budget): %v", err)
	}
	if full.Truncated {
		t.Error("expected truncated = false with the full budget")
	}
	if len(full.Entries) != 20 {
		t.Errorf("entries = %d, want 20", len(full.Entries))
	}
}

func TestListNeverHashes(t *testing.T) {
	root, _ := newTestRoot(t)
	decoded := callList(t, root, ".")
	entries := decoded["entries"].([]any)
	for _, e := range entries {
		em := e.(map[string]any)
		if _, present := em["sha256"]; present {
			t.Errorf("fs_list entry %v carries a sha256; fs_list must never hash", em)
		}
	}
}
