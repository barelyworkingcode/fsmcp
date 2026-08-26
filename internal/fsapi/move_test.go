package fsapi

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func callMove(t *testing.T, root *Root, source, destination string) map[string]any {
	t.Helper()
	raw, err := json.Marshal(moveArgs{Source: source, Destination: destination})
	if err != nil {
		t.Fatal(err)
	}
	result := handleMove(root, raw)
	var decoded map[string]any
	if err := json.Unmarshal([]byte(result.Content[0].Text), &decoded); err != nil {
		t.Fatalf("content not valid JSON: %v (%s)", err, result.Content[0].Text)
	}
	return decoded
}

// TestMoveCaseOnlyRenameSucceeds is B1, the finding that made F1 critical:
// a capitalisation-only rename on case-insensitive APFS must succeed, with
// content intact, and must not be told "exists".
func TestMoveCaseOnlyRenameSucceeds(t *testing.T) {
	root, rootDir := newTestRoot(t)
	target := filepath.Join(rootDir, "meeting.md")
	if err := os.WriteFile(target, []byte("meeting notes"), 0o644); err != nil {
		t.Fatal(err)
	}

	decoded := callMove(t, root, "meeting.md", "Meeting.md")
	if decoded["ok"] != true {
		t.Fatalf("case-only rename: ok = %v, want true (%v)", decoded["ok"], decoded)
	}

	entries, err := os.ReadDir(rootDir)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	count := 0
	for _, e := range entries {
		if e.Name() == "Meeting.md" || e.Name() == "meeting.md" {
			found = true
			count++
		}
	}
	if !found {
		t.Fatal("no meeting.md-like entry survived the rename")
	}
	if count != 1 {
		t.Fatalf("expected exactly one directory entry for meeting.md, found %d", count)
	}

	got, err := os.ReadFile(filepath.Join(rootDir, "Meeting.md"))
	if err != nil {
		t.Fatalf("content not accessible by the new name: %v", err)
	}
	if string(got) != "meeting notes" {
		t.Errorf("content = %q, want %q", got, "meeting notes")
	}
}

// TestMoveCaseOnlyRenameOfDirectorySucceeds is B2.
func TestMoveCaseOnlyRenameOfDirectorySucceeds(t *testing.T) {
	root, rootDir := newTestRoot(t)
	dir := filepath.Join(rootDir, "notesdir")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "x.txt"), []byte("inside"), 0o644); err != nil {
		t.Fatal(err)
	}

	decoded := callMove(t, root, "notesdir", "NotesDir")
	if decoded["ok"] != true {
		t.Fatalf("ok = %v, want true (%v)", decoded["ok"], decoded)
	}
	got, err := os.ReadFile(filepath.Join(rootDir, "NotesDir", "x.txt"))
	if err != nil {
		t.Fatalf("directory contents not reachable after rename: %v", err)
	}
	if string(got) != "inside" {
		t.Errorf("content = %q, want %q", got, "inside")
	}
}

// TestMoveLiteralSelfMoveRefused is B3.
func TestMoveLiteralSelfMoveRefused(t *testing.T) {
	root, rootDir := newTestRoot(t)
	decoded := callMove(t, root, "file.txt", "file.txt")
	errObj, ok := decoded["error"].(map[string]any)
	if decoded["ok"] != false || !ok {
		t.Fatalf("ok = %v, want false with an error", decoded)
	}
	if errObj["code"] != "invalid_argument" {
		t.Errorf("code = %v, want invalid_argument", errObj["code"])
	}
	got, err := os.ReadFile(filepath.Join(rootDir, "file.txt"))
	if err != nil || string(got) != "hello" {
		t.Errorf("source not intact after refused self-move: %q, err=%v", got, err)
	}
}

// TestMoveLiteralSelfMoveViaLeadingSlashRefused: "/file.txt" and "file.txt"
// normalise to the same path, so this is a self-move too.
func TestMoveLiteralSelfMoveViaLeadingSlashRefused(t *testing.T) {
	root, _ := newTestRoot(t)
	decoded := callMove(t, root, "/file.txt", "file.txt")
	errObj, ok := decoded["error"].(map[string]any)
	if decoded["ok"] != false || !ok || errObj["code"] != "invalid_argument" {
		t.Fatalf("decoded = %v, want invalid_argument", decoded)
	}
}

// TestMoveDestinationExistsFileRefused is B4.
func TestMoveDestinationExistsFileRefused(t *testing.T) {
	root, rootDir := newTestRoot(t)
	other := filepath.Join(rootDir, "other.txt")
	if err := os.WriteFile(other, []byte("other content"), 0o644); err != nil {
		t.Fatal(err)
	}

	decoded := callMove(t, root, "file.txt", "other.txt")
	errObj, ok := decoded["error"].(map[string]any)
	if decoded["ok"] != false || !ok || errObj["code"] != "exists" {
		t.Fatalf("decoded = %v, want exists", decoded)
	}

	sourceContent, _ := os.ReadFile(filepath.Join(rootDir, "file.txt"))
	if string(sourceContent) != "hello" {
		t.Errorf("source modified: %q", sourceContent)
	}
	destContent, _ := os.ReadFile(other)
	if string(destContent) != "other content" {
		t.Errorf("destination modified: %q", destContent)
	}
}

// TestMoveDestinationExistsNonEmptyDirRefused is B5.
func TestMoveDestinationExistsNonEmptyDirRefused(t *testing.T) {
	root, rootDir := newTestRoot(t)
	destDir := filepath.Join(rootDir, "destdir")
	if err := os.Mkdir(destDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(destDir, "inside.txt"), []byte("tree"), 0o644); err != nil {
		t.Fatal(err)
	}

	decoded := callMove(t, root, "sub", "destdir")
	errObj, ok := decoded["error"].(map[string]any)
	if decoded["ok"] != false || !ok || errObj["code"] != "exists" {
		t.Fatalf("decoded = %v, want exists", decoded)
	}

	if _, err := os.Stat(filepath.Join(rootDir, "sub")); err != nil {
		t.Errorf("source directory gone after refused move: %v", err)
	}
	got, err := os.ReadFile(filepath.Join(destDir, "inside.txt"))
	if err != nil || string(got) != "tree" {
		t.Errorf("destination tree disturbed: %q, err=%v", got, err)
	}
}

// TestMoveRootAsSourceRefused and TestMoveRootAsDestinationRefused are B7.
func TestMoveRootAsSourceRefused(t *testing.T) {
	root, _ := newTestRoot(t)
	decoded := callMove(t, root, ".", "somewhere-else")
	errObj, ok := decoded["error"].(map[string]any)
	if decoded["ok"] != false || !ok || errObj["code"] != "invalid_argument" {
		t.Fatalf("decoded = %v, want invalid_argument", decoded)
	}
}

func TestMoveRootAsDestinationRefused(t *testing.T) {
	root, _ := newTestRoot(t)
	decoded := callMove(t, root, "file.txt", ".")
	errObj, ok := decoded["error"].(map[string]any)
	if decoded["ok"] != false || !ok || errObj["code"] != "invalid_argument" {
		t.Fatalf("decoded = %v, want invalid_argument", decoded)
	}
}

func TestMoveOrdinaryRename(t *testing.T) {
	root, rootDir := newTestRoot(t)
	decoded := callMove(t, root, "file.txt", "renamed.txt")
	if decoded["ok"] != true {
		t.Fatalf("ok = %v, want true (%v)", decoded["ok"], decoded)
	}
	if _, err := os.Stat(filepath.Join(rootDir, "file.txt")); !os.IsNotExist(err) {
		t.Errorf("old name still present: err=%v", err)
	}
	got, err := os.ReadFile(filepath.Join(rootDir, "renamed.txt"))
	if err != nil || string(got) != "hello" {
		t.Errorf("renamed.txt content = %q, err=%v", got, err)
	}
}

func TestMoveNonexistentSourceRefused(t *testing.T) {
	root, _ := newTestRoot(t)
	decoded := callMove(t, root, "nope.txt", "dest.txt")
	errObj, ok := decoded["error"].(map[string]any)
	if decoded["ok"] != false || !ok || errObj["code"] != "not_found" {
		t.Fatalf("decoded = %v, want not_found", decoded)
	}
}

func TestMoveSourceOutsideRootRefused(t *testing.T) {
	root, _ := newTestRoot(t)
	decoded := callMove(t, root, "../outside/secret.txt", "stolen.txt")
	errObj, ok := decoded["error"].(map[string]any)
	if decoded["ok"] != false || !ok || errObj["code"] != "outside_root" {
		t.Fatalf("decoded = %v, want outside_root", decoded)
	}
}

func TestMoveResultReportsCanonicalPaths(t *testing.T) {
	root, _ := newTestRoot(t)
	decoded := callMove(t, root, "/file.txt", "/renamed.txt")
	if decoded["ok"] != true {
		t.Fatalf("ok = %v, want true (%v)", decoded["ok"], decoded)
	}
	if decoded["source"] != "file.txt" || decoded["destination"] != "renamed.txt" {
		t.Errorf("source/destination = %v/%v, want canonical relative forms", decoded["source"], decoded["destination"])
	}
}

// TestMoveFailureLeavesSourceAndDestinationIntact is B6: a move refused for
// a reason other than a name conflict (here, a destination whose parent
// does not exist) must still leave both source and destination untouched.
func TestMoveFailureLeavesSourceAndDestinationIntact(t *testing.T) {
	root, rootDir := newTestRoot(t)
	decoded := callMove(t, root, "file.txt", "nosuchdir/file.txt")
	if decoded["ok"] != false {
		t.Fatalf("ok = %v, want false", decoded["ok"])
	}
	got, err := os.ReadFile(filepath.Join(rootDir, "file.txt"))
	if err != nil || string(got) != "hello" {
		t.Errorf("source not intact after refused move: %q, err=%v", got, err)
	}
	if _, err := os.Stat(filepath.Join(rootDir, "nosuchdir")); !os.IsNotExist(err) {
		t.Errorf("destination parent unexpectedly created: err=%v", err)
	}
}
