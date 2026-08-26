package fsapi

import (
	"encoding/json"
	"errors"
	"io/fs"
	"syscall"

	"fsmcp/internal/proto"
)

const moveDescription = `Move (rename) a file or directory within the root. There is no "overwrite": an existing ` +
	`destination is always refused. To replace something, delete it first with fs_delete, then move.`

var moveInputSchema = json.RawMessage(`{
  "type": "object",
  "properties": {
    "source": {"type": "string", "description": "Path relative to the root."},
    "destination": {"type": "string", "description": "Path relative to the root."}
  },
  "required": ["source", "destination"],
  "additionalProperties": false
}`)

// RegisterMove wires fs_move into reg.
func RegisterMove(reg *Registry) {
	reg.Register(proto.Tool{
		Name:        "fs_move",
		Description: moveDescription,
		InputSchema: moveInputSchema,
		Annotations: proto.ToolAnnotations{ReadOnlyHint: false, OpenWorldHint: false},
	}, handleMove)
}

type moveArgs struct {
	Source      string `json:"source"`
	Destination string `json:"destination"`
}

type moveResult struct {
	OK          bool   `json:"ok"`
	Source      string `json:"source"`
	Destination string `json:"destination"`
}

func handleMove(root *Root, rawArgs json.RawMessage) *proto.CallToolResult {
	var args moveArgs
	if err := decodeArgs(rawArgs, &args); err != nil {
		return proto.NewErrorResult(proto.ErrInvalidArgument,
			`arguments must be a JSON object with "source" and "destination"`+": "+err.Error(), "")
	}

	source, err := NormalizePath(args.Source)
	if err != nil {
		return Fail(err, args.Source)
	}
	destination, err := NormalizePath(args.Destination)
	if err != nil {
		return Fail(err, args.Destination)
	}

	if source == "." || destination == "." {
		return proto.NewErrorResult(proto.ErrInvalidArgument, "the root itself cannot be moved or moved onto", pickRootOperand(source, destination))
	}

	sourceInfo, err := root.Lstat(source)
	if err != nil {
		return Fail(err, args.Source)
	}

	// This is deliberate: a literal self-move is refused here, by
	// comparing the normalised path strings, before destination is even
	// looked up. A case-only rename (source and destination spelled
	// differently but the same directory entry on a case-insensitive
	// filesystem) must NOT take this branch — it is handled below by
	// comparing (dev, ino) instead, and it is expected to succeed.
	if source == destination {
		return proto.NewErrorResult(proto.ErrInvalidArgument, "source and destination are the same path", source)
	}

	destInfo, err := root.Lstat(destination)
	switch {
	case err == nil:
		// Compare (dev, ino), never path strings. APFS is case-insensitive
		// by default, so Lstat("Meeting.md") finds the entry stored as
		// "meeting.md" and a case-only rename is indistinguishable by name
		// from a real conflict. Equal means both names already denote one
		// entry and the rename below is safe; different means a distinct
		// file sits there and renaming over it would destroy it.
		if !sameEntry(sourceInfo, destInfo) {
			return proto.NewErrorResult(proto.ErrExists, "destination already exists", destination)
		}
	case errors.Is(err, fs.ErrNotExist):
		// Destination does not exist; nothing to compare against.
	default:
		return Fail(err, args.Destination)
	}

	if err := root.Rename(source, destination); err != nil {
		return Fail(err, args.Source)
	}
	return proto.NewSuccessResult(moveResult{OK: true, Source: source, Destination: destination})
}

// sameEntry reports whether a and b are the same filesystem entry, by
// comparing the device and inode number lstat reports for each. It
// deliberately does not compare paths.
func sameEntry(a, b fs.FileInfo) bool {
	as, aok := a.Sys().(*syscall.Stat_t)
	bs, bok := b.Sys().(*syscall.Stat_t)
	if !aok || !bok {
		// Cannot verify identity on this platform; treat as distinct so
		// the caller gets the ordinary "exists" refusal rather than a
		// rename this function could not actually confirm was safe.
		return false
	}
	return as.Dev == bs.Dev && as.Ino == bs.Ino
}

func pickRootOperand(source, destination string) string {
	if source == "." {
		return source
	}
	return destination
}
