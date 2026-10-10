package fsapi

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"fsmcp/internal/proto"
)

// writeArgsJSON builds fs_write arguments with an explicit if_sha256 shape,
// including "absent" (ifSHA256 == nil), which a plain Go struct field
// cannot express — marshaling a struct always emits the key.
func writeArgsJSON(t *testing.T, path, content, encoding string, ifSHA256 *string) json.RawMessage {
	t.Helper()
	m := map[string]any{"path": path, "content": content}
	if encoding != "" {
		m["encoding"] = encoding
	}
	if ifSHA256 != nil {
		if *ifSHA256 == "null" {
			m["if_sha256"] = nil
		} else {
			m["if_sha256"] = *ifSHA256
		}
	}
	raw, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestWriteCreatesNewFile(t *testing.T) {
	root, rootDir := newTestRoot(t)
	null := "null"
	raw := writeArgsJSON(t, "created.txt", "hello world", "", &null)
	result := handleWrite(root, raw)
	var decoded map[string]any
	json.Unmarshal([]byte(result.Content[0].Text), &decoded)

	if decoded["ok"] != true {
		t.Fatalf("ok = %v, want true (%v)", decoded["ok"], decoded)
	}
	got, err := os.ReadFile(filepath.Join(rootDir, "created.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "hello world" {
		t.Errorf("content = %q", got)
	}
	if decoded["bytes"].(float64) != 11 {
		t.Errorf("bytes = %v, want 11", decoded["bytes"])
	}
}

func TestWriteNullPreconditionRefusesExistingFile(t *testing.T) {
	root, _ := newTestRoot(t)
	null := "null"
	raw := writeArgsJSON(t, "file.txt", "new", "", &null)
	result := handleWrite(root, raw)
	assertErrorCode(t, result, "exists")
}

func TestWriteHashPreconditionMatch(t *testing.T) {
	root, rootDir := newTestRoot(t)
	hash := sha256Hex(t, []byte("hello"))
	raw := writeArgsJSON(t, "file.txt", "replaced", "", &hash)
	result := handleWrite(root, raw)
	var decoded map[string]any
	json.Unmarshal([]byte(result.Content[0].Text), &decoded)
	if decoded["ok"] != true {
		t.Fatalf("ok = %v, want true (%v)", decoded["ok"], decoded)
	}
	got, _ := os.ReadFile(filepath.Join(rootDir, "file.txt"))
	if string(got) != "replaced" {
		t.Errorf("content = %q", got)
	}
}

func TestWriteHashPreconditionMismatch(t *testing.T) {
	root, rootDir := newTestRoot(t)
	wrong := sha256Hex(t, []byte("not the content"))
	raw := writeArgsJSON(t, "file.txt", "replaced", "", &wrong)
	result := handleWrite(root, raw)
	assertErrorCode(t, result, "precondition_failed")

	got, _ := os.ReadFile(filepath.Join(rootDir, "file.txt"))
	if string(got) != "hello" {
		t.Errorf("file was modified despite a failed precondition: %q", got)
	}
}

func TestWriteIfSHA256AbsentRefused(t *testing.T) {
	root, _ := newTestRoot(t)
	raw := writeArgsJSON(t, "created.txt", "x", "", nil)
	result := handleWrite(root, raw)
	assertErrorCode(t, result, "invalid_argument")
}

func TestWriteIfSHA256MalformedRefused(t *testing.T) {
	root, _ := newTestRoot(t)
	cases := []string{"not-hex", "abc123", "0123456789012345678901234567890123456789012345678901234567890Z"}
	for _, bad := range cases {
		t.Run(bad, func(t *testing.T) {
			raw := writeArgsJSON(t, "created.txt", "x", "", &bad)
			result := handleWrite(root, raw)
			assertErrorCode(t, result, "invalid_argument")
		})
	}
}

func TestWriteBase64Roundtrip(t *testing.T) {
	root, rootDir := newTestRoot(t)
	raw := []byte{0x00, 0x01, 0xff, 0xfe, 0x89, 'P', 'N', 'G'}
	encoded := base64.StdEncoding.EncodeToString(raw)
	null := "null"
	args := writeArgsJSON(t, "binary.bin", encoded, "base64", &null)
	result := handleWrite(root, args)
	var decoded map[string]any
	json.Unmarshal([]byte(result.Content[0].Text), &decoded)
	if decoded["ok"] != true {
		t.Fatalf("ok = %v, want true (%v)", decoded["ok"], decoded)
	}

	got, err := os.ReadFile(filepath.Join(rootDir, "binary.bin"))
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(raw) {
		t.Errorf("content = %x, want %x", got, raw)
	}
}

func TestWriteInvalidBase64Refused(t *testing.T) {
	root, _ := newTestRoot(t)
	null := "null"
	args := writeArgsJSON(t, "binary.bin", "not valid base64!!", "base64", &null)
	result := handleWrite(root, args)
	assertErrorCode(t, result, "invalid_argument")
}

func TestWriteUnknownEncodingRefused(t *testing.T) {
	root, _ := newTestRoot(t)
	null := "null"
	args := writeArgsJSON(t, "x.txt", "hi", "rot13", &null)
	result := handleWrite(root, args)
	assertErrorCode(t, result, "invalid_argument")
}

func TestWriteToDirectoryRefused(t *testing.T) {
	root, _ := newTestRoot(t)
	null := "null"
	args := writeArgsJSON(t, "sub", "x", "", &null)
	result := handleWrite(root, args)
	assertErrorCode(t, result, "not_a_file")
}

func TestWriteOutsideRootRefused(t *testing.T) {
	root, _ := newTestRoot(t)
	null := "null"
	args := writeArgsJSON(t, "../outside/evil.txt", "x", "", &null)
	result := handleWrite(root, args)
	assertErrorCode(t, result, "outside_root")
}

func TestWriteResultSHA256MatchesContent(t *testing.T) {
	root, _ := newTestRoot(t)
	null := "null"
	args := writeArgsJSON(t, "hashed.txt", "check my hash", "", &null)
	result := handleWrite(root, args)
	var decoded map[string]any
	json.Unmarshal([]byte(result.Content[0].Text), &decoded)
	want := sha256Hex(t, []byte("check my hash"))
	if decoded["sha256"] != want {
		t.Errorf("sha256 = %v, want %v", decoded["sha256"], want)
	}
}

// errorMessage returns the message of an error result, failing the test if the
// result is not an io_error.
func errorMessage(t *testing.T, result *proto.CallToolResult) string {
	t.Helper()
	assertErrorCode(t, result, "io_error")
	var decoded struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal([]byte(result.Content[0].Text), &decoded); err != nil {
		t.Fatal(err)
	}
	return decoded.Error.Message
}

func TestWriteRefusesUnwritableTarget(t *testing.T) {
	cases := []struct {
		name  string
		plant func(t *testing.T, rootDir string)
	}{
		{"owned by another user", func(t *testing.T, rootDir string) {
			plantForeignOwnedFile(t, rootDir, "locked.txt", []byte("original"))
		}},
		{"read-only file the user owns", func(t *testing.T, rootDir string) {
			p := filepath.Join(rootDir, "locked.txt")
			if err := os.WriteFile(p, []byte("original"), 0o444); err != nil {
				t.Fatal(err)
			}
			if err := os.Chmod(p, 0o444); err != nil {
				t.Fatal(err)
			}
		}},
		{"ACL entry denies write", func(t *testing.T, rootDir string) {
			p := filepath.Join(rootDir, "locked.txt")
			if err := os.WriteFile(p, []byte("original"), 0o644); err != nil {
				t.Fatal(err)
			}
			if out, err := exec.Command("/bin/chmod", "+a", "everyone deny write", p).CombinedOutput(); err != nil {
				t.Fatalf("chmod +a: %v: %s", err, out)
			}
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			root, rootDir := newTestRoot(t)
			tc.plant(t, rootDir)
			before := snapshotDisk(t, filepath.Join(rootDir, "locked.txt"))

			hash := sha256Hex(t, []byte("original"))
			result := handleWrite(root, writeArgsJSON(t, "locked.txt", "replacement", "", &hash))

			assertDiskUnchanged(t, rootDir, "locked.txt", before)
			if msg := errorMessage(t, result); !strings.Contains(msg, "not writable") {
				t.Errorf("message does not name write permission: %q", msg)
			}
		})
	}
}
