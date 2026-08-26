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
