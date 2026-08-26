package fsapi

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"time"

	"fsmcp/internal/proto"
)

const statDescription = `Report type, size, mtime, mode and (for regular files) sha256 for a path within the root. Uses lstat, so a symlink is reported as "symlink" rather than as whatever it points to.`

var statInputSchema = json.RawMessage(`{"type":"object","properties":{"path":{"type":"string","description":"Path relative to the root. \".\" or \"\" names the root itself."}},"required":["path"],"additionalProperties":false}`)

// RegisterStat wires fs_stat into reg — the one tool this package
// implements, chosen to prove the JSON-RPC loop end to end.
func RegisterStat(reg *Registry) {
	reg.Register(proto.Tool{
		Name:        "fs_stat",
		Description: statDescription,
		InputSchema: statInputSchema,
		Annotations: proto.ToolAnnotations{ReadOnlyHint: true, OpenWorldHint: false},
	}, handleStat)
}

type statArgs struct {
	Path string `json:"path"`
}

type statResult struct {
	OK     bool   `json:"ok"`
	Path   string `json:"path"`
	Type   string `json:"type"`
	Size   int64  `json:"size"`
	Mtime  string `json:"mtime"`
	Mode   string `json:"mode"`
	SHA256 string `json:"sha256,omitempty"`
}

func handleStat(root *Root, rawArgs json.RawMessage) *proto.CallToolResult {
	var args statArgs
	if err := decodeArgs(rawArgs, &args); err != nil {
		return proto.NewErrorResult(proto.ErrInvalidArgument,
			`arguments must be a JSON object with a "path" string`+": "+err.Error(), "")
	}

	normalized, err := NormalizePath(args.Path)
	if err != nil {
		return Fail(err, args.Path)
	}

	fi, err := root.Lstat(normalized)
	if err != nil {
		return Fail(err, args.Path)
	}

	entryType := classify(fi)
	result := statResult{
		OK:    true,
		Path:  normalized,
		Type:  entryType,
		Size:  reportedSize(fi),
		Mtime: fi.ModTime().UTC().Format(time.RFC3339),
		Mode:  fmt.Sprintf("%04o", fi.Mode().Perm()),
	}

	if entryType == "file" {
		sum, err := hashFile(root, normalized)
		if err != nil {
			return Fail(err, args.Path)
		}
		result.SHA256 = sum
	}

	return proto.NewSuccessResult(result)
}

func classify(fi fs.FileInfo) string {
	switch mode := fi.Mode(); {
	case mode&fs.ModeSymlink != 0:
		return "symlink"
	case mode.IsDir():
		return "dir"
	case mode.IsRegular():
		return "file"
	default:
		return "other"
	}
}

func hashFile(root *Root, name string) (string, error) {
	f, err := root.Open(name)
	if err != nil {
		return "", err
	}
	defer f.Close()

	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// reportedSize zeroes a symlink's size. Lstat reports the byte length of the
// link's target path, which measures a host path the caller is not allowed to
// know: a "latest -> /Volumes/Backup/2026-08-26-nightly" shape is ordinary,
// and its length confirms or eliminates a guess in one call. A link's own size
// is not the size of anything the caller can read.
func reportedSize(fi fs.FileInfo) int64 {
	if fi.Mode()&fs.ModeSymlink != 0 {
		return 0
	}
	return fi.Size()
}
