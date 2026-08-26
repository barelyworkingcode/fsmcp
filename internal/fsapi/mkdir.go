package fsapi

import (
	"encoding/json"
	"errors"
	"io/fs"
	"strings"

	"fsmcp/internal/proto"
)

const mkdirDescription = `Create a directory within the root, recursively, creating any missing parent directories.`

var mkdirInputSchema = json.RawMessage(`{"type":"object","properties":{"path":{"type":"string","description":"Path relative to the root."}},"required":["path"],"additionalProperties":false}`)

// RegisterMkdir wires fs_mkdir into reg.
func RegisterMkdir(reg *Registry) {
	reg.Register(proto.Tool{
		Name:        "fs_mkdir",
		Description: mkdirDescription,
		InputSchema: mkdirInputSchema,
		Annotations: proto.ToolAnnotations{ReadOnlyHint: false, OpenWorldHint: false},
	}, handleMkdir)
}

type mkdirArgs struct {
	Path string `json:"path"`
}

type mkdirResult struct {
	OK      bool     `json:"ok"`
	Path    string   `json:"path"`
	Created []string `json:"created"`
}

// errMkdirBlocked marks a path component that exists but is not a
// directory, so the requested directory could never be created under it.
var errMkdirBlocked = errors.New("path component exists and is not a directory")

func handleMkdir(root *Root, rawArgs json.RawMessage) *proto.CallToolResult {
	var args mkdirArgs
	if err := decodeArgs(rawArgs, &args); err != nil {
		return proto.NewErrorResult(proto.ErrInvalidArgument,
			`arguments must be a JSON object with a "path" string`+": "+err.Error(), "")
	}

	normalized, err := NormalizePath(args.Path)
	if err != nil {
		return Fail(err, args.Path)
	}

	created, mkErr := mkdirAll(root, normalized)
	if mkErr != nil {
		if errors.Is(mkErr, errMkdirBlocked) {
			return proto.NewErrorResult(proto.ErrNotADir, "a path component exists and is not a directory", normalized)
		}
		return Fail(mkErr, args.Path)
	}

	return proto.NewSuccessResult(mkdirResult{OK: true, Path: normalized, Created: created})
}

// mkdirAll creates target and any missing ancestors, walking down from the
// root component by component so each directory this call actually
// created is reported, in the order it came into being. A directory that
// already existed is not repeated in the result.
func mkdirAll(root *Root, target string) ([]string, error) {
	created := []string{}
	if target == "." {
		return created, nil
	}

	parts := strings.Split(target, "/")
	cur := ""
	for _, part := range parts {
		if cur == "" {
			cur = part
		} else {
			cur = cur + "/" + part
		}

		fi, err := root.Lstat(cur)
		switch {
		case err == nil:
			if !fi.IsDir() {
				return created, errMkdirBlocked
			}
		case errors.Is(err, fs.ErrNotExist):
			if err := root.Mkdir(cur, 0o777); err != nil {
				return created, err
			}
			created = append(created, cur)
		default:
			return created, err
		}
	}
	return created, nil
}
