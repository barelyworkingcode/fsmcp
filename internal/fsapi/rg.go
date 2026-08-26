package fsapi

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os/exec"
	"strings"
	"time"

	"fsmcp/internal/proto"
)

// rgTimeout is the wall-clock budget given to one rg invocation. Search
// tools have no pagination the way fs_read does, so an unbounded rg is the
// one way a single call could hang this single-threaded server. A var, not
// a const, so tests can shrink it instead of waiting out the real budget.
var rgTimeout = 30 * time.Second

// rgBinary is the executable runRG invokes. A var, not a literal, purely
// so tests can point it at a stand-in script to force runRG's timeout path
// deterministically; production code never changes it from "rg", which
// main.go has already confirmed resolves on PATH before startup.
var rgBinary = "rg"

// errPatternEscapesRoot marks a glob-syntax argument (fs_glob's pattern,
// fs_grep's glob filter) that names something outside the root: an
// absolute path, or a ".." component, including one hidden inside a brace
// alternative.
var errPatternEscapesRoot = errors.New("pattern escapes the root")

// errRGTimedOut marks an rg invocation killed for exceeding rgTimeout.
var errRGTimedOut = errors.New("rg timed out")

// errRGFailed marks an rg invocation that exited abnormally for a reason
// other than "no matches" (exit 1, which is not a failure — see runRG).
// Callers diagnose the actual cause themselves; rg's stderr is never
// captured, since it writes "<path>: <reason>" and path is a host path.
var errRGFailed = errors.New("rg failed")

// runRG runs rg with argv args, cwd at the root, and returns its stdout.
// rg is never invoked through a shell and never passed -L: cwd being the
// root plus rg's own default of not following symlinks during traversal is
// what keeps the walk inside the root even though the subprocess itself
// runs outside os.Root's protection.
//
// rg's exit code distinguishes three cases: 0 (matched), 1 (ran fine,
// found nothing) and everything else (could not run). The first two both
// return here with a nil error — an empty match set is an ordinary
// success, not a failure.
func runRG(root *Root, args []string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), rgTimeout)
	defer cancel()

	// --no-config: this is deliberate. Without it, a RIPGREP_CONFIG_PATH
	// left in the operator's environment could inject flags we never
	// passed — including --follow, which would break the no-symlink-
	// traversal invariant the containment argument above depends on.
	fullArgs := append([]string{"--no-config"}, args...)
	cmd := exec.CommandContext(ctx, rgBinary, fullArgs...)
	cmd.Dir = root.HostPath()
	var stdout bytes.Buffer
	cmd.Stdout = &stdout
	// Stderr is left nil (-> /dev/null), deliberately: rg writes
	// "<path>: <reason>", and path is cmd.Dir or one of its descendants —
	// a host path. Discarding it unconditionally is what stops it ever
	// reaching a result; a real failure is diagnosed from the Root instead
	// (see diagnoseSearchFailure), never from rg's own words.
	cmd.Stderr = nil

	err := cmd.Run()
	if ctx.Err() != nil {
		return nil, errRGTimedOut
	}
	if err == nil {
		return stdout.Bytes(), nil
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) && exitErr.ExitCode() == 1 {
		return stdout.Bytes(), nil
	}
	return nil, errRGFailed
}

// searchRunError turns a runRG failure into a tool result: a timeout names
// itself, and anything else is diagnosed from the Root rather than from
// rg's own stderr.
func searchRunError(root *Root, err error, normalized, origPath string) *proto.CallToolResult {
	if errors.Is(err, errRGTimedOut) {
		return proto.NewErrorResult(proto.ErrIOError, fmt.Sprintf("search timed out after %s", rgTimeout), origPath)
	}
	return diagnoseSearchFailure(root, normalized, origPath)
}

// checkSearchDir reports a failure result if normalized does not name an
// existing, readable directory under the root, or nil if it does.
func checkSearchDir(root *Root, normalized, origPath string) *proto.CallToolResult {
	fi, err := root.Lstat(normalized)
	if err != nil {
		return Fail(err, origPath)
	}
	if !fi.IsDir() {
		return proto.NewErrorResult(proto.ErrNotADir, "not a directory", origPath)
	}
	if _, err := root.ReadDir(normalized); err != nil {
		if errors.Is(err, fs.ErrPermission) {
			return proto.NewErrorResult(proto.ErrIOError, "directory is not readable", origPath)
		}
		return Fail(err, origPath)
	}
	return nil
}

// validateSearchDir normalizes an optional "path" argument for a search
// tool ("" means the whole root) and confirms it exists and is readable
// before rg ever runs, so a missing or unreadable path is refused outright
// rather than reported as an empty match — an unsearchable directory and
// an empty result must stay distinguishable (ACCEPTANCE F10/F11).
func validateSearchDir(root *Root, path string) (normalized string, failure *proto.CallToolResult) {
	normalized, err := NormalizePath(path)
	if err != nil {
		return "", Fail(err, path)
	}
	if failure := checkSearchDir(root, normalized, path); failure != nil {
		return "", failure
	}
	return normalized, nil
}

// diagnoseSearchFailure explains an rg invocation that could not run at
// all. normalized was already confirmed to exist and be readable by
// validateSearchDir before rg started, so finding a problem with it now
// means the filesystem changed underneath the call; finding none means rg
// rejected the caller's pattern or glob, which is the ordinary case.
func diagnoseSearchFailure(root *Root, normalized, origPath string) *proto.CallToolResult {
	if failure := checkSearchDir(root, normalized, origPath); failure != nil {
		return failure
	}
	return proto.NewErrorResult(proto.ErrInvalidArgument, "rg rejected the pattern", origPath)
}

// trimRGPathPrefix strips the "./" rg prefixes an output path with when
// cwd itself is the search target (DESIGN.md: results are canonical,
// never "./"-prefixed). A no-op when rg was given an explicit subdirectory
// to search, since it then reports paths already rooted at cwd without it.
func trimRGPathPrefix(p string) string {
	return strings.TrimPrefix(p, "./")
}

// validateGlobArg refuses a glob-syntax argument that is not confined to
// the root: an absolute pattern, or one with a ".." component — including
// one that appears only inside a brace alternative, e.g. "{/etc,sub}/*".
// No attempt is made to resolve or collapse the pattern first; any ".."
// component refuses it, whether or not it would have stayed inside the
// root once expanded.
func validateGlobArg(pattern string) error {
	if strings.IndexByte(pattern, 0) >= 0 {
		return ErrInvalidPath
	}
	alts, ok := expandBraces(pattern)
	if !ok {
		// This is deliberate: a pattern too combinatorially large to
		// expand safely cannot be proven confined either, so it is
		// refused rather than validated partially.
		return errPatternEscapesRoot
	}
	for _, alt := range alts {
		if strings.HasPrefix(alt, "/") {
			return errPatternEscapesRoot
		}
		for _, part := range strings.Split(alt, "/") {
			if part == ".." {
				return errPatternEscapesRoot
			}
		}
	}
	return nil
}

// maxBraceExpansions bounds the work expandBraces will do: a chain of N
// two-way brace groups expands to 2^N strings, and nothing a real search
// pattern needs comes anywhere near this many.
const maxBraceExpansions = 4096

// expandBraces expands every {a,b,...} group in pattern, including nested
// ones, so validateGlobArg can check each resulting alternative rather
// than the raw text — a brace group is the one place a glob pattern can
// hide an absolute path or a ".." past a scan of the literal string.
func expandBraces(pattern string) (alts []string, ok bool) {
	start := strings.IndexByte(pattern, '{')
	if start < 0 {
		return []string{pattern}, true
	}
	end := matchingBrace(pattern, start)
	if end < 0 {
		return []string{pattern}, true
	}
	prefix, inner, suffix := pattern[:start], pattern[start+1:end], pattern[end+1:]

	sufAlts, ok := expandBraces(suffix)
	if !ok {
		return nil, false
	}
	var out []string
	for _, part := range splitTopLevel(inner) {
		for _, suf := range sufAlts {
			combined, ok := expandBraces(prefix + part + suf)
			if !ok || len(out)+len(combined) > maxBraceExpansions {
				return nil, false
			}
			out = append(out, combined...)
		}
	}
	return out, true
}

// matchingBrace finds the index of the '}' that closes the '{' at start,
// honouring nested groups, or -1 if pattern's braces are unbalanced.
func matchingBrace(pattern string, start int) int {
	depth := 0
	for i := start; i < len(pattern); i++ {
		switch pattern[i] {
		case '{':
			depth++
		case '}':
			depth--
			if depth == 0 {
				return i
			}
		}
	}
	return -1
}

// splitTopLevel splits s on commas that are not themselves inside a nested
// brace group.
func splitTopLevel(s string) []string {
	var parts []string
	depth, last := 0, 0
	for i, c := range s {
		switch c {
		case '{':
			depth++
		case '}':
			depth--
		case ',':
			if depth == 0 {
				parts = append(parts, s[last:i])
				last = i + 1
			}
		}
	}
	return append(parts, s[last:])
}
