package fsapi

import (
	"encoding/json"
	"sort"
	"time"

	"fsmcp/internal/proto"
)

const listDescription = `List the direct contents of one directory within the root — non-recursive. Never hashes; use fs_stat for a file's sha256. name is a bare filename, never a path. A symlink entry reports size 0 for the reason fs_stat does: Lstat's size for a symlink is the byte length of its target path, a host detail the caller is not allowed to learn.`

var listInputSchema = json.RawMessage(`{"type":"object","properties":{"path":{"type":"string","description":"Path relative to the root. \".\" or \"\" names the root itself."}},"required":["path"],"additionalProperties":false}`)

// RegisterList wires fs_list into reg.
func RegisterList(reg *Registry) {
	reg.Register(proto.Tool{
		Name:        "fs_list",
		Description: listDescription,
		InputSchema: listInputSchema,
		Annotations: proto.ToolAnnotations{ReadOnlyHint: true, OpenWorldHint: false},
	}, handleList)
}

type listArgs struct {
	Path string `json:"path"`
}

type listEntry struct {
	Name  string `json:"name"`
	Type  string `json:"type"`
	Size  int64  `json:"size"`
	Mtime string `json:"mtime"`
}

type listResult struct {
	OK        bool        `json:"ok"`
	Path      string      `json:"path"`
	Entries   []listEntry `json:"entries"`
	Truncated bool        `json:"truncated"`
}

// listEnvelopeReserve leaves headroom for the result's fixed fields, the
// JSON structure around the entries array, and the extra escaping the
// listing's JSON picks up when the JSON-RPC layer re-embeds it as a single
// string value.
const listEnvelopeReserve = 4096

func handleList(root *Root, rawArgs json.RawMessage) *proto.CallToolResult {
	var args listArgs
	if err := decodeArgs(rawArgs, &args); err != nil {
		return proto.NewErrorResult(proto.ErrInvalidArgument,
			`arguments must be a JSON object with a "path" string`+": "+err.Error(), "")
	}

	normalized, err := NormalizePath(args.Path)
	if err != nil {
		return Fail(err, args.Path)
	}

	result, err := listDirectory(root, normalized, root.MaxResponseBytes()-listEnvelopeReserve)
	if err != nil {
		return Fail(err, args.Path)
	}
	result.OK = true
	result.Path = normalized
	return proto.NewSuccessResult(result)
}

// listDirectory does the actual read and bounds the entries against budget,
// a byte ceiling on the marshaled entries array. Split out from handleList
// so tests can drive the truncation path with a small budget instead of a
// directory large enough to hit the real default.
func listDirectory(root *Root, normalized string, budget int) (listResult, error) {
	dirEntries, err := root.ReadDir(normalized)
	if err != nil {
		return listResult{}, err
	}

	sort.Slice(dirEntries, func(i, j int) bool { return dirEntries[i].Name() < dirEntries[j].Name() })

	result := listResult{Entries: []listEntry{}}
	used := 0
	for _, de := range dirEntries {
		fi, err := de.Info()
		if err != nil {
			// The entry existed at readdir time and is gone or unreadable by
			// the time Info runs; skip it rather than fail the whole listing
			// over one race.
			continue
		}
		entry := listEntry{
			Name:  de.Name(),
			Type:  classify(fi),
			Size:  reportedSize(fi),
			Mtime: fi.ModTime().UTC().Format(time.RFC3339),
		}
		b, err := json.Marshal(entry)
		if err != nil {
			continue
		}
		if used+len(b)+1 > budget {
			result.Truncated = true
			break
		}
		used += len(b) + 1
		result.Entries = append(result.Entries, entry)
	}

	return result, nil
}
