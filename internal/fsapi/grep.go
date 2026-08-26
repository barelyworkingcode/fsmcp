package fsapi

import (
	"bufio"
	"bytes"
	"encoding/json"

	"fsmcp/internal/proto"
)

// grepDefaultMaxMatches is used when the caller omits max_matches.
const grepDefaultMaxMatches = 200

const grepDescription = `Search file contents under the root for a regex pattern, via "rg --json". "glob" optionally restricts which files are searched and follows the same rules as fs_glob's pattern: relative only, no ".." component. Matched text is returned exactly as rg reports it, byte for byte. max_matches (default 200) bounds the result; a search cut short by it reports "truncated": true.`

var grepInputSchema = json.RawMessage(`{
	"type":"object",
	"properties":{
		"pattern":{"type":"string","description":"A regular expression to search for."},
		"path":{"type":"string","description":"Directory to search under, relative to the root. Defaults to the root itself."},
		"glob":{"type":"string","description":"Restrict the search to files matching this glob pattern, relative to the root or to \"path\" when given."},
		"max_matches":{"type":"integer","minimum":1,"description":"Maximum number of matches to return. Defaults to 200."}
	},
	"required":["pattern"],
	"additionalProperties":false
}`)

// RegisterGrep wires fs_grep into reg.
func RegisterGrep(reg *Registry) {
	reg.Register(proto.Tool{
		Name:        "fs_grep",
		Description: grepDescription,
		InputSchema: grepInputSchema,
		Annotations: proto.ToolAnnotations{ReadOnlyHint: true, OpenWorldHint: false},
	}, handleGrep)
}

type grepArgs struct {
	Pattern    string `json:"pattern"`
	Path       string `json:"path"`
	Glob       string `json:"glob"`
	MaxMatches *int   `json:"max_matches"`
}

type grepMatch struct {
	Path string `json:"path"`
	Line int64  `json:"line"`
	Text string `json:"text"`
}

type grepResult struct {
	OK        bool        `json:"ok"`
	Matches   []grepMatch `json:"matches"`
	Truncated bool        `json:"truncated"`
}

func handleGrep(root *Root, rawArgs json.RawMessage) *proto.CallToolResult {
	var args grepArgs
	if err := decodeArgs(rawArgs, &args); err != nil {
		return proto.NewErrorResult(proto.ErrInvalidArgument,
			`arguments must be a JSON object with a "pattern" string`+": "+err.Error(), "")
	}

	if bytes.IndexByte([]byte(args.Pattern), 0) >= 0 {
		return proto.NewErrorResult(proto.ErrInvalidArgument, "pattern must not contain a NUL byte", args.Pattern)
	}

	maxMatches := grepDefaultMaxMatches
	if args.MaxMatches != nil {
		if *args.MaxMatches <= 0 {
			return proto.NewErrorResult(proto.ErrInvalidArgument, "max_matches must be positive", "")
		}
		maxMatches = *args.MaxMatches
	}

	if args.Glob != "" {
		if err := validateGlobArg(args.Glob); err != nil {
			return globPatternError(err, args.Glob)
		}
	}

	searchPath, failure := validateSearchDir(root, args.Path)
	if failure != nil {
		return failure
	}

	rgArgs := []string{"--json"}
	if args.Glob != "" {
		rgArgs = append(rgArgs, "-g", args.Glob)
	}
	// -e names the pattern explicitly, so a pattern that happens to start
	// with '-' (e.g. "-h") is never mistaken for an rg flag.
	rgArgs = append(rgArgs, "-e", args.Pattern)
	rgArgs = appendSearchDir(rgArgs, searchPath)

	stdout, err := runRG(root, rgArgs)
	if err != nil {
		return searchRunError(root, err, searchPath, args.Path)
	}

	matches, truncated := parseMatches(stdout, maxMatches)
	return proto.NewSuccessResult(grepResult{OK: true, Matches: matches, Truncated: truncated})
}

// rgEvent is one line of rg --json output.
type rgEvent struct {
	Type string          `json:"type"`
	Data json.RawMessage `json:"data"`
}

type rgMatchData struct {
	Path       rgText `json:"path"`
	Lines      rgText `json:"lines"`
	LineNumber int64  `json:"line_number"`
}

// rgText mirrors rg's {"text": "..."} / {"bytes": "<base64>"} union: rg
// emits "bytes" instead of "text" only when the value is not valid UTF-8,
// which cannot happen for a path or line inside this package's own root
// (os.Root and this OS both require valid-UTF-8 paths). Such an event is
// skipped rather than guessed at.
type rgText struct {
	Text *string `json:"text"`
}

// parseMatches parses rg --json's newline-delimited events, keeping only
// "match" events, capping the result at max and reporting whether more
// were seen. Each JSON line is decoded structurally rather than by
// scanning rg's plain-text output for ":" separators — a path or a
// matched line can itself contain a colon — and the matched text is taken
// from lines.text verbatim: not trimmed, escaped or otherwise rewritten.
func parseMatches(stdout []byte, max int) ([]grepMatch, bool) {
	matches := []grepMatch{}
	truncated := false

	scanner := bufio.NewScanner(bytes.NewReader(stdout))
	scanner.Buffer(make([]byte, 0, 64*1024), 64*1024*1024)
	for scanner.Scan() {
		var ev rgEvent
		if err := json.Unmarshal(scanner.Bytes(), &ev); err != nil || ev.Type != "match" {
			continue
		}
		var data rgMatchData
		if err := json.Unmarshal(ev.Data, &data); err != nil {
			continue
		}
		if data.Path.Text == nil || data.Lines.Text == nil {
			continue
		}
		if len(matches) >= max {
			truncated = true
			continue
		}
		matches = append(matches, grepMatch{
			Path: trimRGPathPrefix(*data.Path.Text),
			Line: data.LineNumber,
			Text: *data.Lines.Text,
		})
	}
	return matches, truncated
}
