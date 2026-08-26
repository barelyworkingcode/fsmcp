package fsapi

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func replaceArgsJSON(t *testing.T, path string, hash *string, edits []editArg) json.RawMessage {
	t.Helper()
	m := map[string]any{"path": path, "edits": edits}
	if hash != nil {
		if *hash == "null" {
			m["if_sha256"] = nil
		} else {
			m["if_sha256"] = *hash
		}
	}
	raw, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestReplaceSingleMatch(t *testing.T) {
	root, rootDir := newTestRoot(t)
	hash := sha256Hex(t, []byte("hello"))
	edits := []editArg{{Find: "hello", Replace: strptr("goodbye")}}
	result := handleReplace(root, replaceArgsJSON(t, "file.txt", &hash, edits))

	var decoded map[string]any
	json.Unmarshal([]byte(result.Content[0].Text), &decoded)
	if decoded["ok"] != true {
		t.Fatalf("ok = %v, want true (%v)", decoded["ok"], decoded)
	}
	got, _ := os.ReadFile(filepath.Join(rootDir, "file.txt"))
	if string(got) != "goodbye" {
		t.Errorf("content = %q, want %q", got, "goodbye")
	}
	counts, ok := decoded["counts"].([]any)
	if !ok || len(counts) != 1 || counts[0].(float64) != 1 {
		t.Errorf("counts = %v, want [1]", decoded["counts"])
	}
}

func TestReplaceEmptyFindRefused(t *testing.T) {
	root, _ := newTestRoot(t)
	hash := sha256Hex(t, []byte("hello"))
	edits := []editArg{{Find: "", Replace: strptr("x")}}
	result := handleReplace(root, replaceArgsJSON(t, "file.txt", &hash, edits))
	assertErrorCode(t, result, "invalid_argument")
}

func TestReplaceIdenticalFindReplaceRefused(t *testing.T) {
	root, _ := newTestRoot(t)
	hash := sha256Hex(t, []byte("hello"))
	edits := []editArg{{Find: "hello", Replace: strptr("hello")}}
	result := handleReplace(root, replaceArgsJSON(t, "file.txt", &hash, edits))
	assertErrorCode(t, result, "invalid_argument")
}

func TestReplaceZeroMatchesRefused(t *testing.T) {
	root, _ := newTestRoot(t)
	hash := sha256Hex(t, []byte("hello"))
	edits := []editArg{{Find: "nonexistent", Replace: strptr("x")}}
	result := handleReplace(root, replaceArgsJSON(t, "file.txt", &hash, edits))
	assertErrorCode(t, result, "no_match")
}

func TestReplaceAmbiguousWithoutAllRefused(t *testing.T) {
	root, rootDir := newTestRoot(t)
	content := "x\nx\nx\n"
	if err := os.WriteFile(filepath.Join(rootDir, "repeat.txt"), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	hash := sha256Hex(t, []byte(content))
	edits := []editArg{{Find: "x", Replace: strptr("y")}}
	result := handleReplace(root, replaceArgsJSON(t, "repeat.txt", &hash, edits))
	assertErrorCode(t, result, "ambiguous_match")

	got, _ := os.ReadFile(filepath.Join(rootDir, "repeat.txt"))
	if string(got) != content {
		t.Errorf("file modified despite refusal: %q", got)
	}
}

// TestReplaceAmbiguousMatchNamesTheCount is E4's "count named" clause: the
// refusal must say how many times find matched, not just that it was more
// than one.
func TestReplaceAmbiguousMatchNamesTheCount(t *testing.T) {
	root, rootDir := newTestRoot(t)
	content := "x\nx\nx\nx\nx\n"
	if err := os.WriteFile(filepath.Join(rootDir, "repeat5.txt"), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	hash := sha256Hex(t, []byte(content))
	edits := []editArg{{Find: "x", Replace: strptr("y")}}
	result := handleReplace(root, replaceArgsJSON(t, "repeat5.txt", &hash, edits))
	var decoded map[string]any
	json.Unmarshal([]byte(result.Content[0].Text), &decoded)
	errObj := decoded["error"].(map[string]any)
	msg, _ := errObj["message"].(string)
	if !strings.Contains(msg, "5") {
		t.Errorf("message = %q, want it to name the match count (5)", msg)
	}
}

func TestReplaceAllTrueReplacesEveryOccurrence(t *testing.T) {
	root, rootDir := newTestRoot(t)
	content := "x\nx\nx\n"
	if err := os.WriteFile(filepath.Join(rootDir, "repeat.txt"), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	hash := sha256Hex(t, []byte(content))
	edits := []editArg{{Find: "x", Replace: strptr("y"), All: true}}
	result := handleReplace(root, replaceArgsJSON(t, "repeat.txt", &hash, edits))

	var decoded map[string]any
	json.Unmarshal([]byte(result.Content[0].Text), &decoded)
	if decoded["ok"] != true {
		t.Fatalf("ok = %v, want true (%v)", decoded["ok"], decoded)
	}
	counts := decoded["counts"].([]any)
	if counts[0].(float64) != 3 {
		t.Errorf("counts = %v, want [3]", decoded["counts"])
	}
	got, _ := os.ReadFile(filepath.Join(rootDir, "repeat.txt"))
	if string(got) != "y\ny\ny\n" {
		t.Errorf("content = %q, want %q", got, "y\ny\ny\n")
	}
}

func TestReplaceEmptyReplaceIsADeletion(t *testing.T) {
	root, rootDir := newTestRoot(t)
	content := "prefix-MARKER-suffix"
	if err := os.WriteFile(filepath.Join(rootDir, "del.txt"), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	hash := sha256Hex(t, []byte(content))
	edits := []editArg{{Find: "-MARKER-", Replace: strptr("")}}
	result := handleReplace(root, replaceArgsJSON(t, "del.txt", &hash, edits))
	var decoded map[string]any
	json.Unmarshal([]byte(result.Content[0].Text), &decoded)
	if decoded["ok"] != true {
		t.Fatalf("ok = %v, want true (%v)", decoded["ok"], decoded)
	}
	got, _ := os.ReadFile(filepath.Join(rootDir, "del.txt"))
	if string(got) != "prefixsuffix" {
		t.Errorf("content = %q, want %q", got, "prefixsuffix")
	}
}

func TestReplaceBatchAllOrNothing(t *testing.T) {
	root, rootDir := newTestRoot(t)
	content := "one two three"
	if err := os.WriteFile(filepath.Join(rootDir, "batch.txt"), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	hash := sha256Hex(t, []byte(content))
	edits := []editArg{
		{Find: "one", Replace: strptr("1")},
		{Find: "nonexistent", Replace: strptr("x")}, // fails
	}
	result := handleReplace(root, replaceArgsJSON(t, "batch.txt", &hash, edits))
	assertErrorCode(t, result, "no_match")

	got, _ := os.ReadFile(filepath.Join(rootDir, "batch.txt"))
	if string(got) != content {
		t.Errorf("edit 1 was applied despite edit 2 failing: %q", got)
	}
}

// TestReplaceBatchAllSucceedIsOneAtomicWriteWithCountsPerEdit is E8: a
// batch where every edit succeeds is one write, and "counts" has one entry
// per edit, in order — not just one edit repeated.
func TestReplaceBatchAllSucceedIsOneAtomicWriteWithCountsPerEdit(t *testing.T) {
	root, rootDir := newTestRoot(t)
	content := "one two three"
	if err := os.WriteFile(filepath.Join(rootDir, "batch2.txt"), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	hash := sha256Hex(t, []byte(content))
	edits := []editArg{
		{Find: "one", Replace: strptr("1")},
		{Find: "three", Replace: strptr("3")},
	}
	result := handleReplace(root, replaceArgsJSON(t, "batch2.txt", &hash, edits))
	var decoded map[string]any
	json.Unmarshal([]byte(result.Content[0].Text), &decoded)
	if decoded["ok"] != true {
		t.Fatalf("ok = %v, want true (%v)", decoded["ok"], decoded)
	}
	counts, ok := decoded["counts"].([]any)
	if !ok || len(counts) != 2 || counts[0].(float64) != 1 || counts[1].(float64) != 1 {
		t.Errorf("counts = %v, want [1,1]", decoded["counts"])
	}
	got, _ := os.ReadFile(filepath.Join(rootDir, "batch2.txt"))
	if string(got) != "1 two 3" {
		t.Errorf("content = %q, want %q", got, "1 two 3")
	}
}

func TestReplaceHashPreconditionMismatch(t *testing.T) {
	root, _ := newTestRoot(t)
	wrong := sha256Hex(t, []byte("wrong"))
	edits := []editArg{{Find: "hello", Replace: strptr("x")}}
	result := handleReplace(root, replaceArgsJSON(t, "file.txt", &wrong, edits))
	assertErrorCode(t, result, "precondition_failed")
}

// TestReplaceHashPreconditionMismatchWritesNothing strengthens E9: not just
// the error code, but that the file is genuinely untouched.
func TestReplaceHashPreconditionMismatchWritesNothing(t *testing.T) {
	root, rootDir := newTestRoot(t)
	wrong := sha256Hex(t, []byte("wrong"))
	edits := []editArg{{Find: "hello", Replace: strptr("x")}}
	handleReplace(root, replaceArgsJSON(t, "file.txt", &wrong, edits))
	got, err := os.ReadFile(filepath.Join(rootDir, "file.txt"))
	if err != nil || string(got) != "hello" {
		t.Errorf("file changed despite a failed precondition: %q, err=%v", got, err)
	}
}

func TestReplaceNullPreconditionOnExistingFileRefused(t *testing.T) {
	root, _ := newTestRoot(t)
	null := "null"
	edits := []editArg{{Find: "hello", Replace: strptr("x")}}
	result := handleReplace(root, replaceArgsJSON(t, "file.txt", &null, edits))
	assertErrorCode(t, result, "exists")
}

// TestReplaceNullPreconditionOnExistingFileWritesNothing strengthens E10 the
// same way: the refusal must leave the file exactly as it was.
func TestReplaceNullPreconditionOnExistingFileWritesNothing(t *testing.T) {
	root, rootDir := newTestRoot(t)
	null := "null"
	edits := []editArg{{Find: "hello", Replace: strptr("x")}}
	handleReplace(root, replaceArgsJSON(t, "file.txt", &null, edits))
	got, err := os.ReadFile(filepath.Join(rootDir, "file.txt"))
	if err != nil || string(got) != "hello" {
		t.Errorf("file changed despite a null-precondition refusal: %q, err=%v", got, err)
	}
}

func TestReplaceIfSHA256AbsentRefused(t *testing.T) {
	root, _ := newTestRoot(t)
	edits := []editArg{{Find: "hello", Replace: strptr("x")}}
	result := handleReplace(root, replaceArgsJSON(t, "file.txt", nil, edits))
	assertErrorCode(t, result, "invalid_argument")
}

func TestReplaceEmptyEditsRefused(t *testing.T) {
	root, _ := newTestRoot(t)
	hash := sha256Hex(t, []byte("hello"))
	result := handleReplace(root, replaceArgsJSON(t, "file.txt", &hash, []editArg{}))
	assertErrorCode(t, result, "invalid_argument")
}

// TestReplaceNonUTF8FileSucceeds is D9, inverted from v2: fs_replace
// operates on raw bytes, so an ASCII edit succeeds even though the file
// also contains a byte sequence that is not valid UTF-8, and that sequence
// is left untouched.
func TestReplaceNonUTF8FileSucceeds(t *testing.T) {
	root, rootDir := newTestRoot(t)
	content := []byte("ok=1\nbad=\xff\xfe\nmore=2\n")
	if err := os.WriteFile(filepath.Join(rootDir, "latin1.txt"), content, 0o644); err != nil {
		t.Fatal(err)
	}
	hash := sha256Hex(t, content)
	edits := []editArg{{Find: "ok=1", Replace: strptr("ok=2")}}
	result := handleReplace(root, replaceArgsJSON(t, "latin1.txt", &hash, edits))

	var decoded map[string]any
	json.Unmarshal([]byte(result.Content[0].Text), &decoded)
	if decoded["ok"] != true {
		t.Fatalf("ok = %v, want true (%v)", decoded["ok"], decoded)
	}
	got, err := os.ReadFile(filepath.Join(rootDir, "latin1.txt"))
	if err != nil {
		t.Fatal(err)
	}
	want := []byte("ok=2\nbad=\xff\xfe\nmore=2\n")
	if string(got) != string(want) {
		t.Errorf("content = %x, want %x", got, want)
	}
}

// TestReplacePreservesBOMCRLFAndMissingFinalNewline covers D2/D3/D4:
// nothing decodes, splits or rejoins the file, so these survive untouched.
func TestReplacePreservesBOMCRLFAndMissingFinalNewline(t *testing.T) {
	root, rootDir := newTestRoot(t)
	content := []byte("\xef\xbb\xbfBOM\r\nCRLF line\r\nno final newline")
	if err := os.WriteFile(filepath.Join(rootDir, "crlf-bom.txt"), content, 0o644); err != nil {
		t.Fatal(err)
	}
	hash := sha256Hex(t, content)
	edits := []editArg{{Find: "CRLF line", Replace: strptr("changed line")}}
	result := handleReplace(root, replaceArgsJSON(t, "crlf-bom.txt", &hash, edits))

	var decoded map[string]any
	json.Unmarshal([]byte(result.Content[0].Text), &decoded)
	if decoded["ok"] != true {
		t.Fatalf("ok = %v, want true (%v)", decoded["ok"], decoded)
	}
	got, err := os.ReadFile(filepath.Join(rootDir, "crlf-bom.txt"))
	if err != nil {
		t.Fatal(err)
	}
	want := []byte("\xef\xbb\xbfBOM\r\nchanged line\r\nno final newline")
	if string(got) != string(want) {
		t.Errorf("content = %q, want %q", got, want)
	}
}

func TestReplaceDirectoryTargetRefused(t *testing.T) {
	root, _ := newTestRoot(t)
	hash := sha256Hex(t, []byte("hello"))
	edits := []editArg{{Find: "x", Replace: strptr("y")}}
	result := handleReplace(root, replaceArgsJSON(t, "sub", &hash, edits))
	assertErrorCode(t, result, "not_a_file")
}

func strptr(s string) *string { return &s }
