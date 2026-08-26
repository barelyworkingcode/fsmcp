package fsapi

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"

	"fsmcp/internal/proto"
)

const replaceDescription = `Apply one or more byte-level find/replace edits to a file within the root, atomically. ` +
	`Operates on raw bytes, not runes or lines — it can edit a file that is not valid UTF-8. Each edit's ` +
	`"find" must occur in the file: zero matches refuses, and more than one match refuses unless "all" is ` +
	`true. The whole batch is all-or-nothing: if any edit fails, nothing is written. "if_sha256" is ` +
	`required: a 64-character lowercase hex sha256 the file must currently hash to, or null to require ` +
	`that the file does not yet exist.`

var replaceInputSchema = json.RawMessage(`{
  "type": "object",
  "properties": {
    "path": {"type": "string", "description": "Path relative to the root."},
    "if_sha256": {
      "type": ["string", "null"],
      "pattern": "^[0-9a-f]{64}$",
      "description": "Required precondition: the file's current sha256, or null to require it does not exist."
    },
    "edits": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "object",
        "properties": {
          "find": {"type": "string", "description": "Exact byte sequence to find. Must not be empty."},
          "replace": {"type": "string", "description": "Replacement bytes. May be empty (a deletion)."},
          "all": {"type": "boolean", "description": "Replace every occurrence. Without it, more than one match refuses."}
        },
        "required": ["find", "replace"],
        "additionalProperties": false
      }
    }
  },
  "required": ["path", "if_sha256", "edits"],
  "additionalProperties": false
}`)

// RegisterReplace wires fs_replace into reg.
func RegisterReplace(reg *Registry) {
	reg.Register(proto.Tool{
		Name:        "fs_replace",
		Description: replaceDescription,
		InputSchema: replaceInputSchema,
		Annotations: proto.ToolAnnotations{ReadOnlyHint: false, OpenWorldHint: false},
	}, handleReplace)
}

type editArg struct {
	Find    string  `json:"find"`
	Replace *string `json:"replace"`
	All     bool    `json:"all,omitempty"`
}

type replaceArgs struct {
	Path     string          `json:"path"`
	IfSHA256 json.RawMessage `json:"if_sha256"`
	Edits    []editArg       `json:"edits"`
}

type replaceResult struct {
	OK     bool   `json:"ok"`
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
	Bytes  int    `json:"bytes"`
	Counts []int  `json:"counts"`
}

func handleReplace(root *Root, rawArgs json.RawMessage) *proto.CallToolResult {
	var args replaceArgs
	if err := decodeArgs(rawArgs, &args); err != nil {
		return proto.NewErrorResult(proto.ErrInvalidArgument,
			`arguments must be a JSON object with "path", "if_sha256" and "edits"`+": "+err.Error(), "")
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
	if len(args.Edits) == 0 {
		return proto.NewErrorResult(proto.ErrInvalidArgument, `"edits" must be a non-empty array`, normalized)
	}

	current, failure := readWithPrecondition(root, normalized, kind, hash)
	if failure != nil {
		return failure
	}

	out, counts, applyErr := applyEdits(current, args.Edits)
	if applyErr != nil {
		return proto.NewErrorResult(mapApplyEditsError(applyErr), applyErr.Error(), normalized)
	}

	if err := AtomicReplace(root, normalized, out); err != nil {
		return mapAtomicReplaceError(err, normalized)
	}

	sum := sha256.Sum256(out)
	return proto.NewSuccessResult(replaceResult{
		OK:     true,
		Path:   normalized,
		SHA256: hex.EncodeToString(sum[:]),
		Bytes:  len(out),
		Counts: counts,
	})
}

var (
	errEmptyFind = errors.New("find must not be empty")
	errIdentical = errors.New("find and replace are identical")
	errNoMatch   = errors.New("find does not occur in the file")
)

// ambiguousMatchError reports how many times an edit's find matched when
// that count made the edit refuse. It is the one apply error that carries
// a value, so it is a type rather than a sentinel.
type ambiguousMatchError struct {
	editIndex int
	count     int
}

func (e *ambiguousMatchError) Error() string {
	return fmt.Sprintf("edit %d: find occurs %d times; set \"all\": true to replace every occurrence", e.editIndex, e.count)
}

// applyEdits is DESIGN.md's fs_replace primitive verbatim: bytes.Count and
// bytes.ReplaceAll operate on raw bytes, never runes, so a file that is not
// valid UTF-8 is editable as long as the edit itself does not need to
// touch its invalid bytes. The whole result is computed in memory before
// AtomicReplace ever runs, so a failing edit leaves every earlier edit in
// the batch unapplied.
func applyEdits(src []byte, edits []editArg) ([]byte, []int, error) {
	out := src
	counts := make([]int, len(edits))
	for i, e := range edits {
		if e.Replace == nil {
			return nil, nil, fmt.Errorf(
				"edit %d: \"replace\" is required; send an empty string to delete the matched bytes", i)
		}
		find := []byte(e.Find)
		replace := []byte(*e.Replace)

		if len(find) == 0 {
			return nil, nil, fmt.Errorf("edit %d: %w", i, errEmptyFind)
		}
		if bytes.Equal(find, replace) {
			return nil, nil, fmt.Errorf("edit %d: %w", i, errIdentical)
		}
		n := bytes.Count(out, find)
		if n == 0 {
			return nil, nil, fmt.Errorf("edit %d: %w", i, errNoMatch)
		}
		if n > 1 && !e.All {
			return nil, nil, &ambiguousMatchError{editIndex: i, count: n}
		}
		out = bytes.ReplaceAll(out, find, replace)
		counts[i] = n
	}
	return out, counts, nil
}

func mapApplyEditsError(err error) proto.ErrorCode {
	var amb *ambiguousMatchError
	switch {
	case errors.As(err, &amb):
		return proto.ErrAmbiguousMatch
	case errors.Is(err, errNoMatch):
		return proto.ErrNoMatch
	case errors.Is(err, errEmptyFind), errors.Is(err, errIdentical):
		return proto.ErrInvalidArgument
	default:
		return proto.ErrIOError
	}
}
