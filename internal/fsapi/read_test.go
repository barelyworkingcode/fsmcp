package fsapi

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func callRead(t *testing.T, root *Root, path string, offset, length *int64) map[string]any {
	t.Helper()
	args, err := json.Marshal(readArgs{Path: path, Offset: offset, Length: length})
	if err != nil {
		t.Fatal(err)
	}
	result := handleRead(root, args)
	if len(result.Content) != 1 || result.Content[0].Type != "text" {
		t.Fatalf("unexpected content: %+v", result.Content)
	}
	var decoded map[string]any
	if err := json.Unmarshal([]byte(result.Content[0].Text), &decoded); err != nil {
		t.Fatalf("content not valid JSON: %v (%s)", err, result.Content[0].Text)
	}
	return decoded
}

func i64(v int64) *int64 { return &v }

func TestReadWholeFileUTF8(t *testing.T) {
	root, _ := newTestRoot(t)
	decoded := callRead(t, root, "file.txt", nil, nil)

	if decoded["ok"] != true {
		t.Fatalf("ok = %v, want true (%v)", decoded["ok"], decoded)
	}
	if decoded["encoding"] != "utf8" {
		t.Errorf("encoding = %v, want utf8", decoded["encoding"])
	}
	if decoded["content"] != "hello" {
		t.Errorf("content = %v, want hello", decoded["content"])
	}
	if decoded["eof"] != true {
		t.Errorf("eof = %v, want true", decoded["eof"])
	}
	if decoded["offset"].(float64) != 0 {
		t.Errorf("offset = %v, want 0", decoded["offset"])
	}
	if decoded["size"].(float64) != 5 {
		t.Errorf("size = %v, want 5", decoded["size"])
	}
	if decoded["length"].(float64) != 5 {
		t.Errorf("length = %v, want 5", decoded["length"])
	}

	sum := sha256.Sum256([]byte("hello"))
	want := hex.EncodeToString(sum[:])
	if decoded["range_sha256"] != want {
		t.Errorf("range_sha256 = %v, want %v", decoded["range_sha256"], want)
	}
	if decoded["sha256"] != want {
		t.Errorf("sha256 = %v, want %v (whole file covered)", decoded["sha256"], want)
	}
}

func TestReadPartialHasNoWholeFileSHA256(t *testing.T) {
	root, _ := newTestRoot(t)
	decoded := callRead(t, root, "file.txt", i64(0), i64(3))

	if decoded["ok"] != true {
		t.Fatalf("ok = %v, want true", decoded["ok"])
	}
	if decoded["content"] != "hel" {
		t.Errorf("content = %v, want hel", decoded["content"])
	}
	if decoded["eof"] != false {
		t.Errorf("eof = %v, want false", decoded["eof"])
	}
	if _, present := decoded["sha256"]; present {
		t.Errorf("partial read carries whole-file sha256: %v", decoded)
	}
	sum := sha256.Sum256([]byte("hel"))
	want := hex.EncodeToString(sum[:])
	if decoded["range_sha256"] != want {
		t.Errorf("range_sha256 = %v, want %v", decoded["range_sha256"], want)
	}
}

func TestReadNonUTF8IsBase64AndByteIdentical(t *testing.T) {
	root, rootDir := newTestRoot(t)
	raw := []byte{0x61, 0xff, 0xfe, 0x62} // not valid UTF-8
	if err := os.WriteFile(filepath.Join(rootDir, "latin1.bin"), raw, 0o644); err != nil {
		t.Fatal(err)
	}

	decoded := callRead(t, root, "latin1.bin", nil, nil)
	if decoded["ok"] != true {
		t.Fatalf("ok = %v, want true (%v)", decoded["ok"], decoded)
	}
	if decoded["encoding"] != "base64" {
		t.Errorf("encoding = %v, want base64", decoded["encoding"])
	}
	got, err := base64.StdEncoding.DecodeString(decoded["content"].(string))
	if err != nil {
		t.Fatalf("content is not valid base64: %v", err)
	}
	if !bytes.Equal(got, raw) {
		t.Errorf("decoded base64 = %v, want %v", got, raw)
	}
}

func TestReadRangeSplittingMultiByteRuneIsBase64(t *testing.T) {
	root, rootDir := newTestRoot(t)
	// "é" is the two bytes 0xC3 0xA9; reading only the first of them must not
	// be silently repaired into valid UTF-8.
	content := []byte("a\xc3\xa9z")
	if err := os.WriteFile(filepath.Join(rootDir, "utf8split.txt"), content, 0o644); err != nil {
		t.Fatal(err)
	}

	decoded := callRead(t, root, "utf8split.txt", i64(1), i64(1))
	if decoded["ok"] != true {
		t.Fatalf("ok = %v, want true (%v)", decoded["ok"], decoded)
	}
	if decoded["encoding"] != "base64" {
		t.Errorf("encoding = %v, want base64 for a range splitting a multi-byte rune", decoded["encoding"])
	}
	got, err := base64.StdEncoding.DecodeString(decoded["content"].(string))
	if err != nil {
		t.Fatalf("content is not valid base64: %v", err)
	}
	if !bytes.Equal(got, []byte{0xc3}) {
		t.Errorf("decoded bytes = %v, want [0xc3]", got)
	}
}

func TestReadChunkedReassemblesByteIdentically(t *testing.T) {
	root, rootDir := newTestRoot(t)
	raw := make([]byte, 5000)
	if _, err := rand.Read(raw); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(rootDir, "big.bin"), raw, 0o644); err != nil {
		t.Fatal(err)
	}

	var got []byte
	const chunk = int64(777)
	offset := int64(0)
	for {
		decoded := callRead(t, root, "big.bin", i64(offset), i64(chunk))
		if decoded["ok"] != true {
			t.Fatalf("ok = %v, want true at offset %d (%v)", decoded["ok"], offset, decoded)
		}
		var piece []byte
		if decoded["encoding"] == "base64" {
			b, err := base64.StdEncoding.DecodeString(decoded["content"].(string))
			if err != nil {
				t.Fatalf("bad base64 at offset %d: %v", offset, err)
			}
			piece = b
		} else {
			piece = []byte(decoded["content"].(string))
		}
		got = append(got, piece...)
		offset += int64(len(piece))
		if decoded["eof"] == true {
			break
		}
		if len(piece) == 0 {
			t.Fatal("made no progress before eof")
		}
	}

	if !bytes.Equal(got, raw) {
		t.Fatalf("reassembled %d bytes != original %d bytes", len(got), len(raw))
	}
}

func TestReadRefusesDirectory(t *testing.T) {
	root, _ := newTestRoot(t)
	decoded := callRead(t, root, "sub", nil, nil)

	if decoded["ok"] != false {
		t.Fatalf("ok = %v, want false", decoded["ok"])
	}
	errObj := decoded["error"].(map[string]any)
	if errObj["code"] != "not_a_file" {
		t.Errorf("code = %v, want not_a_file", errObj["code"])
	}
}

func TestReadNotFound(t *testing.T) {
	root, _ := newTestRoot(t)
	decoded := callRead(t, root, "nope.txt", nil, nil)

	if decoded["ok"] != false {
		t.Fatalf("ok = %v, want false", decoded["ok"])
	}
	errObj := decoded["error"].(map[string]any)
	if errObj["code"] != "not_found" {
		t.Errorf("code = %v, want not_found", errObj["code"])
	}
}

func TestReadNegativeOffsetRefused(t *testing.T) {
	root, _ := newTestRoot(t)
	decoded := callRead(t, root, "file.txt", i64(-1), nil)

	if decoded["ok"] != false {
		t.Fatalf("ok = %v, want false", decoded["ok"])
	}
	errObj := decoded["error"].(map[string]any)
	if errObj["code"] != "invalid_argument" {
		t.Errorf("code = %v, want invalid_argument", errObj["code"])
	}
}

func TestReadNegativeLengthRefused(t *testing.T) {
	root, _ := newTestRoot(t)
	decoded := callRead(t, root, "file.txt", nil, i64(-1))

	if decoded["ok"] != false {
		t.Fatalf("ok = %v, want false", decoded["ok"])
	}
	errObj := decoded["error"].(map[string]any)
	if errObj["code"] != "invalid_argument" {
		t.Errorf("code = %v, want invalid_argument", errObj["code"])
	}
}

func TestReadOffsetAtEOFIsEmptyNotError(t *testing.T) {
	root, _ := newTestRoot(t)
	decoded := callRead(t, root, "file.txt", i64(5), nil)

	if decoded["ok"] != true {
		t.Fatalf("ok = %v, want true (%v)", decoded["ok"], decoded)
	}
	if decoded["content"] != "" {
		t.Errorf("content = %v, want empty", decoded["content"])
	}
	if decoded["eof"] != true {
		t.Errorf("eof = %v, want true", decoded["eof"])
	}
}

func TestReadOffsetPastEOFIsEmptyNotError(t *testing.T) {
	root, _ := newTestRoot(t)
	decoded := callRead(t, root, "file.txt", i64(1000), nil)

	if decoded["ok"] != true {
		t.Fatalf("ok = %v, want true (%v)", decoded["ok"], decoded)
	}
	if decoded["content"] != "" {
		t.Errorf("content = %v, want empty", decoded["content"])
	}
	if decoded["eof"] != true {
		t.Errorf("eof = %v, want true", decoded["eof"])
	}
}

func TestReadZeroLength(t *testing.T) {
	root, _ := newTestRoot(t)
	decoded := callRead(t, root, "file.txt", i64(0), i64(0))

	if decoded["ok"] != true {
		t.Fatalf("ok = %v, want true", decoded["ok"])
	}
	if decoded["content"] != "" {
		t.Errorf("content = %v, want empty", decoded["content"])
	}
	if decoded["eof"] != false {
		t.Errorf("eof = %v, want false (0 of 5 bytes read)", decoded["eof"])
	}
}

func TestReadEscapingSymlinkRefused(t *testing.T) {
	root, _ := newTestRoot(t)
	decoded := callRead(t, root, "escape/secret.txt", nil, nil)

	if decoded["ok"] != false {
		t.Fatalf("ok = %v, want false", decoded["ok"])
	}
	errObj := decoded["error"].(map[string]any)
	if errObj["code"] != "outside_root" {
		t.Errorf("code = %v, want outside_root", errObj["code"])
	}
}

func TestReadNulByteRefused(t *testing.T) {
	root, _ := newTestRoot(t)
	decoded := callRead(t, root, "file\x00.txt", nil, nil)

	if decoded["ok"] != false {
		t.Fatalf("ok = %v, want false", decoded["ok"])
	}
	errObj := decoded["error"].(map[string]any)
	if errObj["code"] != "invalid_argument" {
		t.Errorf("code = %v, want invalid_argument", errObj["code"])
	}
}

func TestReadMalformedArguments(t *testing.T) {
	root, _ := newTestRoot(t)
	result := handleRead(root, json.RawMessage(`not json`))
	if !result.IsError {
		t.Fatal("expected an error result for malformed arguments")
	}
}

// pngFixture is a byte-exact 1x1 PNG, the same shape testkit/mkfixture.sh
// plants: real binary content, not valid UTF-8, to round-trip.
var pngFixture = []byte{
	0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a,
	0x00, 0x00, 0x00, 0x0d, 'I', 'H', 'D', 'R',
	0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
	0x00, 0x00, 0x00, 0x0a, 'I', 'D', 'A', 'T', 'x', 0x9c, 'c', 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4,
	0x00, 0x00, 0x00, 0x00, 'I', 'E', 'N', 'D', 0xae, 'B', 0x60, 0x82,
}

// TestReadThenWriteRoundTripsPNGByteIdentical is D1: a real PNG read via
// fs_read and written back via fs_write, using exactly the content and
// encoding fs_read returned, must land on disk byte-identical.
func TestReadThenWriteRoundTripsPNGByteIdentical(t *testing.T) {
	root, rootDir := newTestRoot(t)
	if err := os.WriteFile(filepath.Join(rootDir, "pixel.png"), pngFixture, 0o644); err != nil {
		t.Fatal(err)
	}

	readDecoded := callRead(t, root, "pixel.png", nil, nil)
	if readDecoded["ok"] != true {
		t.Fatalf("fs_read: ok = %v, want true (%v)", readDecoded["ok"], readDecoded)
	}
	if readDecoded["encoding"] != "base64" {
		t.Fatalf("fs_read encoding = %v, want base64 for PNG bytes", readDecoded["encoding"])
	}

	null := "null"
	writeArgs := writeArgsJSON(t, "pixel-copy.png", readDecoded["content"].(string), "base64", &null)
	writeResult := handleWrite(root, writeArgs)
	var writeDecoded map[string]any
	if err := json.Unmarshal([]byte(writeResult.Content[0].Text), &writeDecoded); err != nil {
		t.Fatalf("fs_write content not valid JSON: %v", err)
	}
	if writeDecoded["ok"] != true {
		t.Fatalf("fs_write: ok = %v, want true (%v)", writeDecoded["ok"], writeDecoded)
	}

	got, err := os.ReadFile(filepath.Join(rootDir, "pixel-copy.png"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, pngFixture) {
		t.Errorf("round-tripped PNG differs: got %d bytes, want %d bytes, equal=%v", len(got), len(pngFixture), bytes.Equal(got, pngFixture))
	}
}

// TestReadWholeMultiByteUTF8FileIsPreservedExactly is D5: a file containing
// multi-byte UTF-8 characters, read whole (no range splitting a rune),
// comes back as encoding "utf8" with the exact original text.
func TestReadWholeMultiByteUTF8FileIsPreservedExactly(t *testing.T) {
	root, rootDir := newTestRoot(t)
	content := "héllo wörld ünicode\n"
	if err := os.WriteFile(filepath.Join(rootDir, "utf8whole.txt"), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}

	decoded := callRead(t, root, "utf8whole.txt", nil, nil)
	if decoded["ok"] != true {
		t.Fatalf("ok = %v, want true (%v)", decoded["ok"], decoded)
	}
	if decoded["encoding"] != "utf8" {
		t.Errorf("encoding = %v, want utf8", decoded["encoding"])
	}
	if decoded["content"] != content {
		t.Errorf("content = %q, want %q", decoded["content"], content)
	}
	want := sha256Hex(t, []byte(content))
	if decoded["sha256"] != want {
		t.Errorf("sha256 = %v, want %v", decoded["sha256"], want)
	}
}

// TestReadLongLineComesBackWholeNotTruncated is D10 (inverted): fs_read has
// no line concept, so a single very long line is not structurally flagged
// or cut short — it comes back whole, subject only to the byte range asked
// for.
func TestReadLongLineComesBackWholeNotTruncated(t *testing.T) {
	root, rootDir := newTestRoot(t)
	line := strings.Repeat("X", 5000)
	if err := os.WriteFile(filepath.Join(rootDir, "longline.txt"), []byte(line), 0o644); err != nil {
		t.Fatal(err)
	}

	decoded := callRead(t, root, "longline.txt", nil, nil)
	if decoded["ok"] != true {
		t.Fatalf("ok = %v, want true (%v)", decoded["ok"], decoded)
	}
	if decoded["content"] != line {
		t.Errorf("content length = %d, want %d (line came back truncated or altered)", len(decoded["content"].(string)), len(line))
	}
	if decoded["length"].(float64) != float64(len(line)) {
		t.Errorf("length = %v, want %d", decoded["length"], len(line))
	}
	if decoded["eof"] != true {
		t.Errorf("eof = %v, want true", decoded["eof"])
	}
}

// TestReadDefaultLengthFitsBase64Budget pins the accounting DESIGN.md
// describes: the default length assumes base64's 4/3 expansion, so even a
// worst-case-encoded response of exactly that many raw bytes stays under the
// operator's configured response budget.
func TestReadDefaultLengthFitsBase64Budget(t *testing.T) {
	root, _ := newTestRoot(t)
	for _, budget := range []int{64 * 1024, DefaultMaxResponseBytes} {
		root.SetMaxResponseBytes(budget)
		n := maxReadLength(root)
		if n <= 0 {
			t.Fatalf("maxReadLength(budget=%d) = %d, want positive", budget, n)
		}
		if base64Size := ((n + 2) / 3) * 4; base64Size >= int64(budget) {
			t.Errorf("base64 of %d bytes does not fit budget %d", n, budget)
		}
	}
}
