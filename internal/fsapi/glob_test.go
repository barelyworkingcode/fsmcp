package fsapi

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func callGlob(t *testing.T, root *Root, args globArgs) map[string]any {
	t.Helper()
	raw, err := json.Marshal(args)
	if err != nil {
		t.Fatal(err)
	}
	result := handleGlob(root, raw)
	if len(result.Content) != 1 || result.Content[0].Type != "text" {
		t.Fatalf("unexpected content: %+v", result.Content)
	}
	var decoded map[string]any
	if err := json.Unmarshal([]byte(result.Content[0].Text), &decoded); err != nil {
		t.Fatalf("content not valid JSON: %v (%s)", err, result.Content[0].Text)
	}
	return decoded
}

func globPaths(t *testing.T, decoded map[string]any) []string {
	t.Helper()
	raw, ok := decoded["paths"].([]any)
	if !ok {
		t.Fatalf("paths missing or wrong shape: %v", decoded)
	}
	paths := make([]string, len(raw))
	for i, p := range raw {
		paths[i] = p.(string)
	}
	return paths
}

func TestGlobOrdinaryMatch(t *testing.T) {
	requireRG(t)
	root, rootDir := newTestRoot(t)
	if err := os.WriteFile(filepath.Join(rootDir, "notes.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	decoded := callGlob(t, root, globArgs{Pattern: "notes.txt"})
	if decoded["ok"] != true {
		t.Fatalf("ok = %v, want true (%v)", decoded["ok"], decoded)
	}
	paths := globPaths(t, decoded)
	if len(paths) != 1 || paths[0] != "notes.txt" {
		t.Errorf("paths = %v, want [notes.txt]", paths)
	}
	if decoded["truncated"] != false {
		t.Errorf("truncated = %v, want false", decoded["truncated"])
	}
}

func TestGlobPathArgumentScopesSearch(t *testing.T) {
	requireRG(t)
	root, rootDir := newTestRoot(t)
	if err := os.WriteFile(filepath.Join(rootDir, "sub", "nested.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(rootDir, "top.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	decoded := callGlob(t, root, globArgs{Pattern: "*.txt", Path: "sub"})
	if decoded["ok"] != true {
		t.Fatalf("ok = %v, want true", decoded["ok"])
	}
	paths := globPaths(t, decoded)
	if len(paths) != 1 || paths[0] != "sub/nested.txt" {
		t.Errorf("paths = %v, want [sub/nested.txt]", paths)
	}
}

func TestGlobNoMatchIsEmptySuccess(t *testing.T) {
	requireRG(t)
	root, _ := newTestRoot(t)

	decoded := callGlob(t, root, globArgs{Pattern: "*.no-such-extension"})
	if decoded["ok"] != true {
		t.Fatalf("ok = %v, want true (a search that matches nothing is a success)", decoded["ok"])
	}
	if paths := globPaths(t, decoded); len(paths) != 0 {
		t.Errorf("paths = %v, want empty", paths)
	}
}

func TestGlobMissingPathIsError(t *testing.T) {
	root, _ := newTestRoot(t)
	decoded := callGlob(t, root, globArgs{Pattern: "*", Path: "nosuchdir"})
	if decoded["ok"] != false {
		t.Fatalf("ok = %v, want false — a missing path must never be an empty success", decoded["ok"])
	}
	errObj := decoded["error"].(map[string]any)
	if errObj["code"] != "not_found" {
		t.Errorf("code = %v, want not_found", errObj["code"])
	}
}

func TestGlobUnreadablePathIsError(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("running as root bypasses permission checks")
	}
	root, rootDir := newTestRoot(t)
	locked := filepath.Join(rootDir, "locked")
	if err := os.Mkdir(locked, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(locked, 0); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(locked, 0o755) })

	decoded := callGlob(t, root, globArgs{Pattern: "*", Path: "locked"})
	if decoded["ok"] != false {
		t.Fatalf("ok = %v, want false — an unreadable path must never be an empty success", decoded["ok"])
	}
	errObj := decoded["error"].(map[string]any)
	if errObj["code"] != "io_error" {
		t.Errorf("code = %v, want io_error", errObj["code"])
	}
}

func TestGlobAbsolutePatternRefused(t *testing.T) {
	root, _ := newTestRoot(t)
	decoded := callGlob(t, root, globArgs{Pattern: "/etc/passwd"})
	if decoded["ok"] != false {
		t.Fatalf("ok = %v, want false", decoded["ok"])
	}
	errObj := decoded["error"].(map[string]any)
	if errObj["code"] != "outside_root" {
		t.Errorf("code = %v, want outside_root", errObj["code"])
	}
}

func TestGlobDotDotPatternRefused(t *testing.T) {
	root, _ := newTestRoot(t)
	decoded := callGlob(t, root, globArgs{Pattern: "../*"})
	if decoded["ok"] != false {
		t.Fatalf("ok = %v, want false", decoded["ok"])
	}
	errObj := decoded["error"].(map[string]any)
	if errObj["code"] != "outside_root" {
		t.Errorf("code = %v, want outside_root", errObj["code"])
	}
}

func TestGlobBraceSmugglingRefused(t *testing.T) {
	root, _ := newTestRoot(t)
	decoded := callGlob(t, root, globArgs{Pattern: "{/etc,sub}/*"})
	if decoded["ok"] != false {
		t.Fatalf("ok = %v, want false", decoded["ok"])
	}
	errObj := decoded["error"].(map[string]any)
	if errObj["code"] != "outside_root" {
		t.Errorf("code = %v, want outside_root", errObj["code"])
	}
}

func TestGlobNulByteInPatternRefused(t *testing.T) {
	root, _ := newTestRoot(t)
	decoded := callGlob(t, root, globArgs{Pattern: "notes/\x00x.md"})
	if decoded["ok"] != false {
		t.Fatalf("ok = %v, want false", decoded["ok"])
	}
	errObj := decoded["error"].(map[string]any)
	if errObj["code"] != "invalid_argument" {
		t.Errorf("code = %v, want invalid_argument", errObj["code"])
	}
}

func TestGlobPatternRefusalNeverInvokesRG(t *testing.T) {
	// A refused pattern must be caught before rg is ever spawned, so this
	// assertion holds even without rg installed.
	root, _ := newTestRoot(t)
	origBinary := rgBinary
	rgBinary = "/no/such/binary/anywhere"
	t.Cleanup(func() { rgBinary = origBinary })

	decoded := callGlob(t, root, globArgs{Pattern: "../*"})
	if decoded["ok"] != false {
		t.Fatalf("ok = %v, want false", decoded["ok"])
	}
	errObj := decoded["error"].(map[string]any)
	if errObj["code"] != "outside_root" {
		t.Errorf("code = %v, want outside_root (got %v — did this reach rg?)", errObj["code"], errObj)
	}
}

func TestGlobHostileFilenameNewlineIsOneIntactEntry(t *testing.T) {
	requireRG(t)
	root, rootDir := newTestRoot(t)
	if err := os.WriteFile(filepath.Join(rootDir, "we\nird.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	decoded := callGlob(t, root, globArgs{Pattern: "we*"})
	if decoded["ok"] != true {
		t.Fatalf("ok = %v, want true (%v)", decoded["ok"], decoded)
	}
	paths := globPaths(t, decoded)
	if len(paths) != 1 || paths[0] != "we\nird.txt" {
		t.Errorf("paths = %q, want exactly one intact entry [\"we\\nird.txt\"]", paths)
	}
}

func TestGlobResultPathsAreCanonical(t *testing.T) {
	requireRG(t)
	root, rootDir := newTestRoot(t)
	if err := os.WriteFile(filepath.Join(rootDir, "top.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	decoded := callGlob(t, root, globArgs{Pattern: "*.txt"})
	for _, p := range globPaths(t, decoded) {
		if strings.HasPrefix(p, "./") || strings.HasPrefix(p, "/") {
			t.Errorf("path %q is not canonical (relative, no leading \"./\")", p)
		}
	}
}

func TestParseFileListTruncates(t *testing.T) {
	stdout := []byte("a.txt\x00b.txt\x00c.txt\x00d.txt\x00")
	paths, truncated := parseFileList(stdout, 2)
	if !truncated {
		t.Fatal("expected truncated = true")
	}
	if len(paths) != 2 {
		t.Fatalf("paths = %v, want 2 entries", paths)
	}
}

func TestParseFileListNotTruncatedWhenUnderCap(t *testing.T) {
	stdout := []byte("a.txt\x00b.txt\x00")
	paths, truncated := parseFileList(stdout, 10)
	if truncated {
		t.Fatal("expected truncated = false")
	}
	if len(paths) != 2 {
		t.Fatalf("paths = %v, want 2 entries", paths)
	}
}

func TestParseFileListEmpty(t *testing.T) {
	paths, truncated := parseFileList(nil, 10)
	if truncated {
		t.Fatal("expected truncated = false for empty input")
	}
	if len(paths) != 0 {
		t.Fatalf("paths = %v, want empty", paths)
	}
}
