package fsapi

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// requireRG skips a test that needs a real rg binary to run against, on a
// machine where one is not on PATH.
func requireRG(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("rg"); err != nil {
		t.Skip("rg not found on PATH")
	}
}

// withSlowRG points rgBinary at a script that ignores every argument and
// sleeps, and shrinks rgTimeout well below that sleep — deterministically
// forcing runRG's timeout path without waiting out a real, large search.
func withSlowRG(t *testing.T) {
	t.Helper()
	script := filepath.Join(t.TempDir(), "slow-rg")
	if err := os.WriteFile(script, []byte("#!/bin/sh\nsleep 5\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	origBinary, origTimeout := rgBinary, rgTimeout
	rgBinary, rgTimeout = script, 50*time.Millisecond
	t.Cleanup(func() { rgBinary, rgTimeout = origBinary, origTimeout })
}

func TestRunRGTimesOut(t *testing.T) {
	root, _ := newTestRoot(t)
	withSlowRG(t)

	_, err := runRG(root, []string{"--files"})
	if !errors.Is(err, errRGTimedOut) {
		t.Fatalf("runRG error = %v, want errRGTimedOut", err)
	}
}

func TestRunRGNoMatchIsNotAnError(t *testing.T) {
	requireRG(t)
	root, _ := newTestRoot(t)

	out, err := runRG(root, []string{"--files", "-g", "*.no-such-extension"})
	if err != nil {
		t.Fatalf("runRG: %v", err)
	}
	if len(out) != 0 {
		t.Errorf("stdout = %q, want empty", out)
	}
}

func TestRunRGBadPatternFails(t *testing.T) {
	requireRG(t)
	root, _ := newTestRoot(t)

	_, err := runRG(root, []string{"--json", "-e", "(unclosed"})
	if !errors.Is(err, errRGFailed) {
		t.Fatalf("runRG error = %v, want errRGFailed", err)
	}
}

func TestValidateGlobArg(t *testing.T) {
	cases := []struct {
		name    string
		pattern string
		wantErr error // nil means "no error"
	}{
		{"plain extension glob", "*.go", nil},
		{"nested relative glob", "sub/*.txt", nil},
		{"double star", "**/*.go", nil},
		{"absolute pattern", "/etc/passwd", errPatternEscapesRoot},
		{"dotdot component", "../*", errPatternEscapesRoot},
		{"dotdot deeper in pattern", "sub/../../x", errPatternEscapesRoot},
		{"dotdot collapsed by a literal is still refused", "sub/../top.txt", errPatternEscapesRoot},
		{"brace smuggling absolute", "{/etc,sub}/*", errPatternEscapesRoot},
		{"brace smuggling dotdot", "{sub,../x}/*", errPatternEscapesRoot},
		{"nested brace, both alternatives safe", "{a,{b,c}}/*.go", nil},
		{"nul byte", "notes/\x00x.md", ErrInvalidPath},
		{"three dots is not dotdot", ".../x", nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := validateGlobArg(tc.pattern)
			if tc.wantErr == nil {
				if err != nil {
					t.Errorf("validateGlobArg(%q) = %v, want nil", tc.pattern, err)
				}
				return
			}
			if !errors.Is(err, tc.wantErr) {
				t.Errorf("validateGlobArg(%q) = %v, want %v", tc.pattern, err, tc.wantErr)
			}
		})
	}
}

func TestValidateGlobArgRefusesExcessiveBraceExpansion(t *testing.T) {
	// 13 two-way groups expand to 2^13 = 8192 alternatives, past
	// maxBraceExpansions (4096) — refused as unsafe to validate, not
	// silently truncated.
	pattern := strings.Repeat("{a,b}", 13)
	if err := validateGlobArg(pattern); !errors.Is(err, errPatternEscapesRoot) {
		t.Errorf("validateGlobArg(large brace pattern) = %v, want errPatternEscapesRoot", err)
	}
}

func TestExpandBraces(t *testing.T) {
	cases := []struct {
		name    string
		pattern string
		want    []string
	}{
		{"no braces", "plain/*.go", []string{"plain/*.go"}},
		{"one group", "{a,b}", []string{"a", "b"}},
		{"group with surrounding text", "pre{a,b}post", []string{"preapost", "prebpost"}},
		{"nested group", "{a,{b,c}}", []string{"a", "b", "c"}},
		{"two sibling groups multiply", "{a,b}{c,d}", []string{"ac", "ad", "bc", "bd"}},
		{"unbalanced brace is left literal", "{abc", []string{"{abc"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := expandBraces(tc.pattern)
			if !ok {
				t.Fatalf("expandBraces(%q) ok = false", tc.pattern)
			}
			if len(got) != len(tc.want) {
				t.Fatalf("expandBraces(%q) = %v, want %v", tc.pattern, got, tc.want)
			}
			for i := range got {
				if got[i] != tc.want[i] {
					t.Errorf("expandBraces(%q)[%d] = %q, want %q", tc.pattern, i, got[i], tc.want[i])
				}
			}
		})
	}
}

func TestTrimRGPathPrefix(t *testing.T) {
	cases := []struct{ in, want string }{
		{"./notes/x.txt", "notes/x.txt"},
		{"notes/x.txt", "notes/x.txt"},
		{".", "."},
	}
	for _, tc := range cases {
		if got := trimRGPathPrefix(tc.in); got != tc.want {
			t.Errorf("trimRGPathPrefix(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestValidateSearchDirMissingIsError(t *testing.T) {
	root, _ := newTestRoot(t)
	_, failure := validateSearchDir(root, "nosuchdir")
	if failure == nil || !failure.IsError {
		t.Fatal("expected an error result for a missing search directory")
	}
}

func TestValidateSearchDirRefusesFile(t *testing.T) {
	root, _ := newTestRoot(t)
	_, failure := validateSearchDir(root, "file.txt")
	if failure == nil || !failure.IsError {
		t.Fatal("expected an error result for a file passed as a search directory")
	}
}

func TestValidateSearchDirRoot(t *testing.T) {
	root, _ := newTestRoot(t)
	normalized, failure := validateSearchDir(root, "")
	if failure != nil {
		t.Fatalf("unexpected failure for the root itself: %+v", failure)
	}
	if normalized != "." {
		t.Errorf("normalized = %q, want \".\"", normalized)
	}
}

// --- the search directory is a path, never a flag ---

// mkdirInRoot creates a directory under the root through the Root itself,
// exactly as fs_mkdir would — which is the point: a caller can name a
// directory anything, so the search tools must treat a name that looks like
// an rg flag as the ordinary directory name it is.
func mkdirInRoot(t *testing.T, root *Root, name string) {
	t.Helper()
	if _, err := mkdirAll(root, name); err != nil {
		t.Fatalf("mkdirAll(%q): %v", name, err)
	}
}

func TestAppendSearchDirEndsTheFlagsFirst(t *testing.T) {
	got := appendSearchDir([]string{"--json", "-e", "x"}, "sub")
	want := []string{"--json", "-e", "x", "--", "sub"}
	if strings.Join(got, " ") != strings.Join(want, " ") {
		t.Errorf("argv = %v, want %v", got, want)
	}
	if only := appendSearchDir([]string{"--files"}, "."); strings.Join(only, " ") != "--files" {
		t.Errorf("argv for the root = %v, want the flags unchanged", only)
	}
}

// A directory named "--follow" must be searched, not obeyed. Without the "--"
// that ends rg's flags, rg reads the name as its own --follow, drops back to
// searching the whole root, and traverses the symlinks that leave it — so the
// escape shows up as a match under a root-relative path and does not read as
// an escape at all.
func TestGrepSearchDirNamedLikeAFlagDoesNotLeaveTheRoot(t *testing.T) {
	requireRG(t)
	root, _ := newTestRoot(t)
	mkdirInRoot(t, root, "--follow")

	decoded := callGrep(t, root, grepArgs{Pattern: "secret", Path: "--follow"})
	if decoded["ok"] != true {
		t.Fatalf("ok = %v, want true (%v)", decoded["ok"], decoded)
	}
	if matches := grepMatches(t, decoded); len(matches) != 0 {
		t.Errorf("matches = %v, want none — content from outside the root reached the caller", matches)
	}
}

func TestGlobSearchDirNamedLikeAFlagDoesNotLeaveTheRoot(t *testing.T) {
	requireRG(t)
	root, _ := newTestRoot(t)
	mkdirInRoot(t, root, "--follow")

	decoded := callGlob(t, root, globArgs{Pattern: "*", Path: "--follow"})
	if decoded["ok"] != true {
		t.Fatalf("ok = %v, want true (%v)", decoded["ok"], decoded)
	}
	if paths := globPaths(t, decoded); len(paths) != 0 {
		t.Errorf("paths = %v, want none — files outside the root were enumerated", paths)
	}
}

// rg's --pre names a command rg runs over every file it searches, so a search
// directory read as a flag is not only a containment escape but an execution
// primitive: fsMCP publishes no tool that runs anything, and must not lend
// ripgrep's.
func TestGrepSearchDirCannotMakeRGRunACommand(t *testing.T) {
	requireRG(t)
	root, rootDir := newTestRoot(t)

	sentinel := filepath.Join(t.TempDir(), "executed")
	payload := "touch '" + sentinel + "'\n"
	if err := os.WriteFile(filepath.Join(rootDir, "payload.txt"), []byte(payload), 0o644); err != nil {
		t.Fatal(err)
	}
	mkdirInRoot(t, root, "--pre=/bin/sh")

	callGrep(t, root, grepArgs{Pattern: "anything", Path: "--pre=/bin/sh"})

	if _, err := os.Stat(sentinel); err == nil {
		t.Fatal("rg executed a file in the root: the search directory was parsed as --pre")
	} else if !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("stat sentinel: %v", err)
	}
}

// --- what the search sees is the directory, not a VCS's opinion of it ---

func TestSearchSeesHiddenFiles(t *testing.T) {
	requireRG(t)
	root, rootDir := newTestRoot(t)
	if err := os.WriteFile(filepath.Join(rootDir, ".env"), []byte("api_key=live\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	matches := grepMatches(t, callGrep(t, root, grepArgs{Pattern: "api_key"}))
	if len(matches) != 1 || matches[0]["path"] != ".env" {
		t.Errorf("matches = %v, want the one in .env — a dotfile fs_list shows must not be invisible to fs_grep", matches)
	}
}

func TestSearchIsNotFilteredByAnIgnoreFileInsideTheRoot(t *testing.T) {
	requireRG(t)
	root, rootDir := newTestRoot(t)
	if err := os.WriteFile(filepath.Join(rootDir, "credentials.txt"), []byte("aws_key=AKIA\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(rootDir, ".ignore"), []byte("credentials.txt\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	matches := grepMatches(t, callGrep(t, root, grepArgs{Pattern: "aws_key"}))
	if len(matches) != 1 || matches[0]["path"] != "credentials.txt" {
		t.Errorf("matches = %v, want the one in credentials.txt — an ignore file is not an access control", matches)
	}
}

// The sharpest form: the ignore file is OUTSIDE the root, so a document the
// caller cannot see, cannot edit and was never shown decides what the search
// reports about files that are inside it. This is the same hazard --no-config
// closes for RIPGREP_CONFIG_PATH, reached through a file instead of an
// environment variable.
func TestSearchIsNotFilteredByAnIgnoreFileAboveTheRoot(t *testing.T) {
	requireRG(t)
	root, rootDir := newTestRoot(t)
	if err := os.WriteFile(filepath.Join(rootDir, "credentials.txt"), []byte("aws_key=AKIA\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	above := filepath.Join(filepath.Dir(rootDir), ".ignore")
	if err := os.WriteFile(above, []byte("credentials.txt\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	matches := grepMatches(t, callGrep(t, root, grepArgs{Pattern: "aws_key"}))
	if len(matches) != 1 || matches[0]["path"] != "credentials.txt" {
		t.Errorf("matches = %v, want the one in credentials.txt — a file outside the root decided what is visible inside it", matches)
	}
}

// DESIGN.md's "one way to do each thing" applied to the two tools that
// enumerate: a file fs_list reports must not be missing from fs_glob, whose
// result says "truncated": false and therefore claims to be complete.
func TestGlobAndListAgreeOnWhichFilesExist(t *testing.T) {
	requireRG(t)
	root, rootDir := newTestRoot(t)
	for name, body := range map[string]string{
		".hidden.txt": "a\n",
		"ignored.txt": "b\n",
		".ignore":     "ignored.txt\n",
		"plain.txt":   "c\n",
	} {
		if err := os.WriteFile(filepath.Join(rootDir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	globbed := map[string]bool{}
	for _, p := range globPaths(t, callGlob(t, root, globArgs{Pattern: "*"})) {
		globbed[p] = true
	}

	listed, err := listDirectory(root, ".", root.MaxResponseBytes())
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range listed.Entries {
		if e.Type != "file" {
			continue
		}
		if !globbed[e.Name] {
			t.Errorf("fs_list reports %q but fs_glob does not, while claiming a complete result", e.Name)
		}
	}
}
