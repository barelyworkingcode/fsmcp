package fsapi

import (
	"bytes"
	"encoding/json"
	"io/fs"

	"fsmcp/internal/proto"
)

const deleteDescription = `Delete a file, symlink or directory within the root. "recursive" is required to delete a ` +
	`non-empty directory and defaults to false. A recursive delete unlinks a symlink it meets rather than ` +
	`descending through it. "if_sha256" is an optional precondition for a regular file.`

var deleteInputSchema = json.RawMessage(`{
  "type": "object",
  "properties": {
    "path": {"type": "string", "description": "Path relative to the root."},
    "recursive": {"type": "boolean", "description": "Required to delete a non-empty directory. Defaults to false."},
    "if_sha256": {"type": "string", "pattern": "^[0-9a-f]{64}$", "description": "Optional precondition: the file's current sha256."}
  },
  "required": ["path"],
  "additionalProperties": false
}`)

// RegisterDelete wires fs_delete into reg.
func RegisterDelete(reg *Registry) {
	reg.Register(proto.Tool{
		Name:        "fs_delete",
		Description: deleteDescription,
		InputSchema: deleteInputSchema,
		Annotations: proto.ToolAnnotations{ReadOnlyHint: false, OpenWorldHint: false},
	}, handleDelete)
}

type deleteArgs struct {
	Path      string          `json:"path"`
	Recursive bool            `json:"recursive,omitempty"`
	IfSHA256  json.RawMessage `json:"if_sha256,omitempty"`
}

type deleteResult struct {
	OK      bool   `json:"ok"`
	Path    string `json:"path"`
	Deleted bool   `json:"deleted"`
}

func handleDelete(root *Root, rawArgs json.RawMessage) *proto.CallToolResult {
	var args deleteArgs
	if err := decodeArgs(rawArgs, &args); err != nil {
		return proto.NewErrorResult(proto.ErrInvalidArgument,
			`arguments must be a JSON object with a "path" string`+": "+err.Error(), "")
	}

	normalized, err := NormalizePath(args.Path)
	if err != nil {
		return Fail(err, args.Path)
	}
	if normalized == "." {
		return proto.NewErrorResult(proto.ErrInvalidArgument, "the root itself cannot be deleted", normalized)
	}

	wantHash, hashOK := parseDeletePrecondition(args.IfSHA256)
	if !hashOK {
		return proto.NewErrorResult(proto.ErrInvalidArgument, `if_sha256, when present, must be a 64-character lowercase hex string`, normalized)
	}

	fi, err := root.Lstat(normalized)
	if err != nil {
		return Fail(err, args.Path)
	}

	if wantHash != "" {
		if failure := verifyDeleteHash(root, normalized, fi, wantHash); failure != nil {
			return failure
		}
	}

	if fi.IsDir() {
		if !args.Recursive {
			empty, err := isEmptyDir(root, normalized)
			if err != nil {
				return Fail(err, args.Path)
			}
			if !empty {
				return proto.NewErrorResult(proto.ErrInvalidArgument, `directory is not empty; pass "recursive": true to remove its contents`, normalized)
			}
		}
		// os.Root.RemoveAll shares os.RemoveAll's own symlink safety: it
		// lstats each entry it walks and unlinks anything that is not
		// itself a directory, a symlink included, rather than following
		// it — so a symlink to somewhere outside the root is removed as
		// the link it is, and whatever it points to is never touched.
		if err := root.RemoveAll(normalized); err != nil {
			return Fail(err, args.Path)
		}
	} else {
		if err := root.Remove(normalized); err != nil {
			return Fail(err, args.Path)
		}
	}

	return proto.NewSuccessResult(deleteResult{OK: true, Path: normalized, Deleted: true})
}

// parseDeletePrecondition reads the optional if_sha256 precondition.
// Unlike fs_write/fs_replace, absence is legal here (no precondition), so
// this only needs to tell "absent" from "a valid hex hash" from
// "anything else", the last of which is a schema violation.
func parseDeletePrecondition(raw json.RawMessage) (hash string, ok bool) {
	if len(raw) == 0 || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return "", true
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return "", false
	}
	if !hexSHA256Pattern.MatchString(s) {
		return "", false
	}
	return s, true
}

func verifyDeleteHash(root *Root, p string, fi fs.FileInfo, wantHash string) *proto.CallToolResult {
	if !fi.Mode().IsRegular() {
		return proto.NewErrorResult(proto.ErrNotAFile, "not a regular file", p)
	}
	// Streamed, not read: the bytes are about to be unlinked, so holding the
	// whole file to produce a digest that is compared and dropped costs memory
	// proportional to the file for nothing.
	sum, err := hashFile(root, p)
	if err != nil {
		return Fail(err, p)
	}
	if sum != wantHash {
		return preconditionMismatch(p)
	}
	return nil
}

func isEmptyDir(root *Root, p string) (bool, error) {
	entries, err := root.ReadDir(p)
	if err != nil {
		return false, err
	}
	return len(entries) == 0, nil
}
