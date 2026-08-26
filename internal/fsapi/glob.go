package fsapi

import (
	"bytes"
	"encoding/json"
	"errors"

	"fsmcp/internal/proto"
)

// globMaxPaths bounds fs_glob's own result, independent of
// --max-response-bytes: DESIGN.md requires "truncated" to be a real
// signal, so this package must cap its own output rather than rely
// entirely on main.go's line-length backstop.
const globMaxPaths = 1000

const globDescription = `List files under the root whose relative path matches a glob pattern, via "rg --files -g <pattern>". The pattern must be relative to the root (or to "path", when given): an absolute pattern, or one containing a ".." component — including inside a brace alternative like "{/etc,sub}/*" — is refused.`

var globInputSchema = json.RawMessage(`{
	"type":"object",
	"properties":{
		"pattern":{"type":"string","description":"A glob pattern, relative to the root or to \"path\" when given."},
		"path":{"type":"string","description":"Directory to search under, relative to the root. Defaults to the root itself."}
	},
	"required":["pattern"],
	"additionalProperties":false
}`)

// RegisterGlob wires fs_glob into reg.
func RegisterGlob(reg *Registry) {
	reg.Register(proto.Tool{
		Name:        "fs_glob",
		Description: globDescription,
		InputSchema: globInputSchema,
		Annotations: proto.ToolAnnotations{ReadOnlyHint: true, OpenWorldHint: false},
	}, handleGlob)
}

type globArgs struct {
	Pattern string `json:"pattern"`
	Path    string `json:"path"`
}

type globResult struct {
	OK        bool     `json:"ok"`
	Paths     []string `json:"paths"`
	Truncated bool     `json:"truncated"`
}

func handleGlob(root *Root, rawArgs json.RawMessage) *proto.CallToolResult {
	var args globArgs
	if err := decodeArgs(rawArgs, &args); err != nil {
		return proto.NewErrorResult(proto.ErrInvalidArgument,
			`arguments must be a JSON object with a "pattern" string`+": "+err.Error(), "")
	}

	if err := validateGlobArg(args.Pattern); err != nil {
		return globPatternError(err, args.Pattern)
	}

	searchPath, failure := validateSearchDir(root, args.Path)
	if failure != nil {
		return failure
	}

	rgArgs := appendSearchDir([]string{"--files", "--null", "-g", args.Pattern}, searchPath)

	stdout, err := runRG(root, rgArgs)
	if err != nil {
		return searchRunError(root, err, searchPath, args.Path)
	}

	paths, truncated := parseFileList(stdout, globMaxPaths)
	return proto.NewSuccessResult(globResult{OK: true, Paths: paths, Truncated: truncated})
}

func globPatternError(err error, pattern string) *proto.CallToolResult {
	if errors.Is(err, ErrInvalidPath) {
		return proto.NewErrorResult(proto.ErrInvalidArgument, "pattern must not contain a NUL byte", pattern)
	}
	return proto.NewErrorResult(proto.ErrOutsideRoot, `pattern must be relative to the root and contain no ".." component`, pattern)
}

// parseFileList splits rg --files --null's NUL-delimited stdout into
// paths, capping at max and reporting whether more remained. --null is
// what makes this safe against a filename containing a literal newline
// (ACCEPTANCE F13): rg terminates every path with the one byte a POSIX
// filename cannot contain, so splitting on it is exact rather than
// probable the way splitting plain "--files" output on '\n' would be.
func parseFileList(stdout []byte, max int) ([]string, bool) {
	raw := bytes.Split(stdout, []byte{0})
	// The final element after splitting on the NUL terminator is always
	// an empty trailer, not a path.
	if len(raw) > 0 && len(raw[len(raw)-1]) == 0 {
		raw = raw[:len(raw)-1]
	}

	truncated := len(raw) > max
	if truncated {
		raw = raw[:max]
	}
	paths := make([]string, len(raw))
	for i, p := range raw {
		paths[i] = trimRGPathPrefix(string(p))
	}
	return paths, truncated
}
