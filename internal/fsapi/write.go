package fsapi

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"

	"fsmcp/internal/proto"
)

var (
	errInvalidBase64   = errors.New(`"content" is not valid base64`)
	errUnknownEncoding = errors.New(`"encoding" must be "utf8" or "base64"`)
)

const writeDescription = `Write content to a file within the root, replacing it atomically. ` +
	`"if_sha256" is required: a 64-character lowercase hex sha256 the file must currently hash to, ` +
	`or null to require that the file does not yet exist (this is how you create one). There is no ` +
	`default, so this cannot be called without stating what you expect to be overwriting.`

var writeInputSchema = json.RawMessage(`{
  "type": "object",
  "properties": {
    "path": {"type": "string", "description": "Path relative to the root."},
    "content": {"type": "string", "description": "File content, encoded per \"encoding\"."},
    "encoding": {"type": "string", "enum": ["utf8", "base64"], "description": "Encoding of \"content\". Defaults to \"utf8\"."},
    "if_sha256": {
      "type": ["string", "null"],
      "pattern": "^[0-9a-f]{64}$",
      "description": "Required precondition: the file's current sha256, or null to require it does not exist."
    }
  },
  "required": ["path", "content", "if_sha256"],
  "additionalProperties": false
}`)

// RegisterWrite wires fs_write into reg.
func RegisterWrite(reg *Registry) {
	reg.Register(proto.Tool{
		Name:        "fs_write",
		Description: writeDescription,
		InputSchema: writeInputSchema,
		Annotations: proto.ToolAnnotations{ReadOnlyHint: false, OpenWorldHint: false},
	}, handleWrite)
}

type writeArgs struct {
	Path     string          `json:"path"`
	Content  *string         `json:"content"`
	Encoding string          `json:"encoding"`
	IfSHA256 json.RawMessage `json:"if_sha256"`
}

type writeResult struct {
	OK     bool   `json:"ok"`
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
	Bytes  int    `json:"bytes"`
}

func handleWrite(root *Root, rawArgs json.RawMessage) *proto.CallToolResult {
	var args writeArgs
	if err := decodeArgs(rawArgs, &args); err != nil {
		return proto.NewErrorResult(proto.ErrInvalidArgument,
			`arguments must be a JSON object with "path", "content" and "if_sha256"`+": "+err.Error(), "")
	}

	normalized, err := NormalizePath(args.Path)
	if err != nil {
		return Fail(err, args.Path)
	}

	kind, hash, ok := parsePrecondition(args.IfSHA256)
	if !ok {
		return proto.NewErrorResult(proto.ErrInvalidArgument,
			`if_sha256 must be a 64-character lowercase hex string, or null to require the file not exist`, normalized)
	}
	if kind == preconditionAbsent {
		return proto.NewErrorResult(proto.ErrInvalidArgument,
			`if_sha256 is required: a 64-character lowercase hex string, or null to require the file not exist`, normalized)
	}

	content, missing := requiredString(args.Content, "content")
	if missing != nil {
		return proto.NewErrorResult(proto.ErrInvalidArgument, missing.Error(), normalized)
	}

	data, decodeErr := decodeWriteContent(content, args.Encoding)
	if decodeErr != nil {
		return proto.NewErrorResult(proto.ErrInvalidArgument, decodeErr.Error(), normalized)
	}

	if _, failure := checkPrecondition(root, normalized, kind, hash); failure != nil {
		return failure
	}

	if err := AtomicReplace(root, normalized, data); err != nil {
		return mapAtomicReplaceError(err, normalized)
	}

	sum := sha256.Sum256(data)
	return proto.NewSuccessResult(writeResult{
		OK:     true,
		Path:   normalized,
		SHA256: hex.EncodeToString(sum[:]),
		Bytes:  len(data),
	})
}

// decodeWriteContent decodes content per encoding, DESIGN.md's two
// supported spellings. An unrecognised encoding, or base64 content outside
// the base64 alphabet, is a caller mistake to report — never a silent
// best-effort decode, which could write bytes the caller did not send.
func decodeWriteContent(content, encoding string) ([]byte, error) {
	switch encoding {
	case "", "utf8":
		return []byte(content), nil
	case "base64":
		data, err := base64.StdEncoding.DecodeString(content)
		if err != nil {
			return nil, errInvalidBase64
		}
		return data, nil
	default:
		return nil, errUnknownEncoding
	}
}

// mapAtomicReplaceError turns an AtomicReplace failure into a tool result.
// This package's own sentinels are not os errors, so they are classified
// directly rather than through Fail/MapError.
func mapAtomicReplaceError(err error, p string) *proto.CallToolResult {
	switch {
	case errors.Is(err, errNotRegularFile):
		return proto.NewErrorResult(proto.ErrNotAFile, "not a regular file", p)
	case errors.Is(err, errAttrsUnpreservable):
		return proto.NewErrorResult(proto.ErrIOError, "the file's mode, extended attributes or ACL could not be preserved; nothing was written", p)
	case errors.Is(err, errTargetUndeletable):
		return proto.NewErrorResult(proto.ErrIOError, "this file's ACL denies delete, and fsMCP replaces a file by renaming over it, so it cannot be written; nothing was changed. Remove the deny-delete entry to make it writable through fsMCP", p)
	default:
		return Fail(err, p)
	}
}
