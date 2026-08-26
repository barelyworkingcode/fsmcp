package fsapi

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"unicode/utf8"

	"fsmcp/internal/proto"
)

const readDescription = `Read a byte range from a file within the root. offset and length are bytes — there is no line concept anywhere, no line numbers and no truncation of long lines. length defaults to whatever fits the response budget. encoding is decided by fsMCP from the returned bytes, never requested: "utf8" when the returned range is valid UTF-8, "base64" otherwise — a range that splits a multi-byte rune is therefore base64, not repaired. range_sha256 always covers the returned bytes; the whole-file sha256 is present only when the read covered the whole file, so a chunked read does not rehash the file per chunk. Refuses a directory or other non-regular file with not_a_file.`

var readInputSchema = json.RawMessage(`{"type":"object","properties":{"path":{"type":"string","description":"Path relative to the root. \".\" or \"\" names the root itself."},"offset":{"type":"integer","minimum":0,"description":"Byte offset to start reading from. Defaults to 0."},"length":{"type":"integer","minimum":0,"description":"Number of bytes to read. Defaults to whatever fits the response budget."}},"required":["path"],"additionalProperties":false}`)

// RegisterRead wires fs_read into reg.
func RegisterRead(reg *Registry) {
	reg.Register(proto.Tool{
		Name:        "fs_read",
		Description: readDescription,
		InputSchema: readInputSchema,
		Annotations: proto.ToolAnnotations{ReadOnlyHint: true, OpenWorldHint: false},
	}, handleRead)
}

type readArgs struct {
	Path   string `json:"path"`
	Offset *int64 `json:"offset"`
	Length *int64 `json:"length"`
}

type readResult struct {
	OK          bool   `json:"ok"`
	Path        string `json:"path"`
	Size        int64  `json:"size"`
	Offset      int64  `json:"offset"`
	Length      int64  `json:"length"`
	EOF         bool   `json:"eof"`
	Encoding    string `json:"encoding"`
	Content     string `json:"content"`
	RangeSHA256 string `json:"range_sha256"`
	SHA256      string `json:"sha256,omitempty"`
}

// readEnvelopeReserve leaves headroom for the result's fixed fields and the
// extra escaping the reply's JSON picks up when the JSON-RPC layer re-embeds
// it as a single string value.
const readEnvelopeReserve = 4096

// defaultReadLength is how many raw bytes fs_read asks for when the caller
// omits length. It assumes the worst case for wire size — base64, which
// expands 4/3 — so the default page fits the response budget regardless of
// which encoding the returned bytes end up choosing.
func maxReadLength(root *Root) int64 {
	available := int64(root.MaxResponseBytes() - readEnvelopeReserve)
	if available < 0 {
		return 0
	}
	return available * 3 / 4
}

func handleRead(root *Root, rawArgs json.RawMessage) *proto.CallToolResult {
	var args readArgs
	if err := decodeArgs(rawArgs, &args); err != nil {
		return proto.NewErrorResult(proto.ErrInvalidArgument,
			`arguments must be a JSON object with a "path" string`+": "+err.Error(), "")
	}

	normalized, err := NormalizePath(args.Path)
	if err != nil {
		return Fail(err, args.Path)
	}

	offset := int64(0)
	if args.Offset != nil {
		offset = *args.Offset
	}
	if offset < 0 {
		return proto.NewErrorResult(proto.ErrInvalidArgument, "offset must not be negative", normalized)
	}

	// An explicit over-budget length is refused here, naming the ceiling.
	// Letting it through would trip main.go's whole-response backstop, which
	// says "this is a bug in fsmcp" — training a caller to ignore the one
	// alarm that should only ever mean a real bug.
	maxLength := maxReadLength(root)
	length := maxLength
	if args.Length != nil {
		if *args.Length < 0 {
			return proto.NewErrorResult(proto.ErrInvalidArgument, "length must not be negative", normalized)
		}
		if *args.Length > maxLength {
			return proto.NewErrorResult(proto.ErrTooLarge, fmt.Sprintf(
				"length %d exceeds the %d bytes that fit one response; read the file in ranges of at most that size",
				*args.Length, maxLength), normalized)
		}
		length = *args.Length
	}

	fi, err := root.Stat(normalized)
	if err != nil {
		return Fail(err, args.Path)
	}
	if !fi.Mode().IsRegular() {
		return proto.NewErrorResult(proto.ErrNotAFile, "not a regular file", normalized)
	}

	result, err := readRange(root, normalized, fi.Size(), offset, length)
	if err != nil {
		return Fail(err, args.Path)
	}
	result.OK = true
	result.Path = normalized
	return proto.NewSuccessResult(result)
}

// readRange performs the positional read and builds the result fields, given
// a file already known to be a regular file of size bytes. Split out from
// handleRead so tests can exercise offset/length/EOF edge cases directly,
// without needing files sized to the real response budget.
func readRange(root *Root, normalized string, size, offset, length int64) (readResult, error) {
	available := size - offset
	if available < 0 {
		available = 0
	}
	readLen := length
	if readLen > available {
		readLen = available
	}

	var buf []byte
	if readLen > 0 {
		f, err := root.Open(normalized)
		if err != nil {
			return readResult{}, err
		}
		defer f.Close()

		// *os.File is what root.Open actually returns under the fs.File
		// interface, and it always implements io.ReaderAt via pread — this
		// is what lets a windowed read of a large file allocate only the
		// window, never the whole file.
		ra, ok := f.(io.ReaderAt)
		if !ok {
			return readResult{}, errors.New("file does not support positional reads")
		}
		buf = make([]byte, readLen)
		n, err := ra.ReadAt(buf, offset)
		if err != nil && !errors.Is(err, io.EOF) {
			return readResult{}, err
		}
		buf = buf[:n]
	}

	end := offset + int64(len(buf))
	eof := end >= size

	sum := sha256.Sum256(buf)
	rangeHash := hex.EncodeToString(sum[:])

	result := readResult{
		Size:        size,
		Offset:      offset,
		Length:      int64(len(buf)),
		EOF:         eof,
		RangeSHA256: rangeHash,
	}
	if utf8.Valid(buf) {
		result.Encoding = "utf8"
		result.Content = string(buf)
	} else {
		result.Encoding = "base64"
		result.Content = base64.StdEncoding.EncodeToString(buf)
	}
	// The whole-file hash is only meaningful, and only cheap, when this read
	// covered the file end to end — it is then identical to range_sha256,
	// computed above, rather than a second pass over the bytes.
	if offset == 0 && eof {
		result.SHA256 = rangeHash
	}
	return result, nil
}
