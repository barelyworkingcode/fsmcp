package fsapi

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

// A misspelled or absent content field must never be read as "write nothing".
// Go's default is to ignore an unknown field and leave the intended one at its
// zero value, which for content is the empty string — so without strict
// decoding a typo truncates the file and the call reports success.
func TestTypoedOrAbsentContentNeverTruncates(t *testing.T) {
	const original = "CONTENT-HERE"
	cases := []struct {
		name string
		tool string
		args string
	}{
		{"write, misspelled content", "fs_write", `{"path":"f.txt","if_sha256":%q,"contents":"NEW"}`},
		{"write, absent content", "fs_write", `{"path":"f.txt","if_sha256":%q}`},
		{"replace, misspelled replace", "fs_replace", `{"path":"f.txt","if_sha256":%q,"edits":[{"find":"CONTENT","replacement":"NEW"}]}`},
		{"replace, absent replace", "fs_replace", `{"path":"f.txt","if_sha256":%q,"edits":[{"find":"CONTENT"}]}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			root, dir := newTestRoot(t)
			target := filepath.Join(dir, "f.txt")
			if err := os.WriteFile(target, []byte(original), 0o644); err != nil {
				t.Fatal(err)
			}
			sum := fileSHA256(t, target)

			reg := NewRegistry(root, false)
			RegisterWrite(reg)
			RegisterReplace(reg)
			res := reg.Call(tc.tool, json.RawMessage(fmt.Sprintf(tc.args, sum)), nil)

			if !res.IsError {
				t.Errorf("call succeeded; it must refuse rather than write")
			}
			got, err := os.ReadFile(target)
			if err != nil {
				t.Fatal(err)
			}
			if string(got) != original {
				t.Errorf("file = %q, want it untouched (%q)", got, original)
			}
		})
	}
}

// The legitimate empty cases must keep working: an explicit "" is a request to
// write nothing, and an explicit "" replacement is a deletion.
func TestExplicitEmptyStillAllowed(t *testing.T) {
	root, dir := newTestRoot(t)
	target := filepath.Join(dir, "f.txt")
	os.WriteFile(target, []byte("CONTENT-HERE"), 0o644)
	reg := NewRegistry(root, false)
	RegisterWrite(reg)

	res := reg.Call("fs_write", json.RawMessage(
		fmt.Sprintf(`{"path":"f.txt","if_sha256":%q,"content":""}`, fileSHA256(t, target))), nil)
	if res.IsError {
		t.Fatalf("explicit empty content was refused: %s", res.Content[0].Text)
	}
	if b, _ := os.ReadFile(target); len(b) != 0 {
		t.Errorf("file = %q, want empty", b)
	}
}

func fileSHA256(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}
