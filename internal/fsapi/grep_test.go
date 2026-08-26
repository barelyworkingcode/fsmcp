package fsapi

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func callGrep(t *testing.T, root *Root, args grepArgs) map[string]any {
	t.Helper()
	raw, err := json.Marshal(args)
	if err != nil {
		t.Fatal(err)
	}
	result := handleGrep(root, raw)
	if len(result.Content) != 1 || result.Content[0].Type != "text" {
		t.Fatalf("unexpected content: %+v", result.Content)
	}
	var decoded map[string]any
	if err := json.Unmarshal([]byte(result.Content[0].Text), &decoded); err != nil {
		t.Fatalf("content not valid JSON: %v (%s)", err, result.Content[0].Text)
	}
	return decoded
}

func grepMatches(t *testing.T, decoded map[string]any) []map[string]any {
	t.Helper()
	raw, ok := decoded["matches"].([]any)
	if !ok {
		t.Fatalf("matches missing or wrong shape: %v", decoded)
	}
	out := make([]map[string]any, len(raw))
	for i, m := range raw {
		out[i] = m.(map[string]any)
	}
	return out
}

func intPtr(n int) *int { return &n }

func TestGrepOrdinaryMatch(t *testing.T) {
	requireRG(t)
	root, rootDir := newTestRoot(t)
	if err := os.WriteFile(filepath.Join(rootDir, "config.txt"), []byte("a=1\nb=2\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	decoded := callGrep(t, root, grepArgs{Pattern: "a=1"})
	if decoded["ok"] != true {
		t.Fatalf("ok = %v, want true (%v)", decoded["ok"], decoded)
	}
	matches := grepMatches(t, decoded)
	if len(matches) != 1 {
		t.Fatalf("matches = %v, want exactly 1", matches)
	}
	m := matches[0]
	if m["path"] != "config.txt" {
		t.Errorf("path = %v, want config.txt", m["path"])
	}
	if m["line"].(float64) != 1 {
		t.Errorf("line = %v, want 1", m["line"])
	}
	if decoded["truncated"] != false {
		t.Errorf("truncated = %v, want false", decoded["truncated"])
	}
}

func TestGrepMatchedTextIsNeverAltered(t *testing.T) {
	requireRG(t)
	root, rootDir := newTestRoot(t)
	// Shell metacharacters and regex-special punctuation, written to disk
	// exactly once and searched for with the same literal text — proves
	// the returned text field is a byte-for-byte copy of the source line,
	// not a re-escaped or reformatted view of it.
	line := `payload $(touch /tmp/pwned) ` + "`id`" + ` ; ls > out.txt end`
	if err := os.WriteFile(filepath.Join(rootDir, "inj.txt"), []byte(line+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	decoded := callGrep(t, root, grepArgs{Pattern: "payload \\$\\(touch"})
	matches := grepMatches(t, decoded)
	if len(matches) != 1 {
		t.Fatalf("matches = %v, want exactly 1", matches)
	}
	if got := matches[0]["text"]; got != line+"\n" {
		t.Errorf("text = %q, want %q", got, line+"\n")
	}
	if _, err := os.Stat("/tmp/pwned"); err == nil {
		t.Fatal("injected command actually ran: /tmp/pwned exists")
	}
}

// TestGrepPatternWithShellMetacharactersNeverInvokesAShell is F1/F2/F3: the
// pattern argument itself — not file content — carries command
// substitution, backticks and a shell redirect. rg runs as an argv array,
// never a shell string, so none of it can execute a command or write a
// file, whatever rg makes of it as a regex.
func TestGrepPatternWithShellMetacharactersNeverInvokesAShell(t *testing.T) {
	requireRG(t)
	root, rootDir := newTestRoot(t)
	if err := os.WriteFile(filepath.Join(rootDir, "plain.txt"), []byte("nothing interesting\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	canary := filepath.Join(t.TempDir(), "pwned")
	cases := []struct {
		name    string
		pattern string
	}{
		{"command substitution", "$(touch " + canary + ")"},
		{"backticks", "`touch " + canary + "`"},
		{"semicolon", "x; touch " + canary},
		{"redirect", "x > " + canary},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			callGrep(t, root, grepArgs{Pattern: tc.pattern})
			if _, err := os.Stat(canary); err == nil {
				t.Fatalf("pattern %q ran as a shell command: %s exists", tc.pattern, canary)
			}
		})
	}
}

// TestGrepPatternWithEmbeddedNewlineIsOneArgvElement is F4: a pattern
// containing a literal newline must reach rg as a single argv element
// following "-e", never split into two.
func TestGrepPatternWithEmbeddedNewlineIsOneArgvElement(t *testing.T) {
	root, _ := newTestRoot(t)
	dumpFile := filepath.Join(t.TempDir(), "argv.txt")
	script := filepath.Join(t.TempDir(), "argv-dump-rg")
	body := "#!/bin/sh\nfor a in \"$@\"; do printf '%s\\0' \"$a\" >> \"" + dumpFile + "\"; done\nexit 1\n"
	if err := os.WriteFile(script, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	origBinary := rgBinary
	rgBinary = script
	t.Cleanup(func() { rgBinary = origBinary })

	pattern := "line1\nline2"
	callGrep(t, root, grepArgs{Pattern: pattern})

	dumped, err := os.ReadFile(dumpFile)
	if err != nil {
		t.Fatalf("stand-in rg never ran: %v", err)
	}
	args := strings.Split(strings.TrimSuffix(string(dumped), "\x00"), "\x00")
	found := false
	for i, a := range args {
		if a == "-e" && i+1 < len(args) && args[i+1] == pattern {
			found = true
		}
	}
	if !found {
		t.Errorf("pattern with embedded newline did not arrive as one argv element after -e: %q", args)
	}
}

func TestGrepPatternLooksLikeAFlag(t *testing.T) {
	requireRG(t)
	root, rootDir := newTestRoot(t)
	if err := os.WriteFile(filepath.Join(rootDir, "flags.txt"), []byte("weird -h line\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	decoded := callGrep(t, root, grepArgs{Pattern: "-h"})
	if decoded["ok"] != true {
		t.Fatalf("ok = %v, want true (%v) — pattern must not be parsed as an rg flag", decoded["ok"], decoded)
	}
	matches := grepMatches(t, decoded)
	if len(matches) != 1 {
		t.Fatalf("matches = %v, want exactly 1", matches)
	}
}

func TestGrepPathArgumentScopesSearch(t *testing.T) {
	requireRG(t)
	root, rootDir := newTestRoot(t)
	if err := os.WriteFile(filepath.Join(rootDir, "sub", "nested.txt"), []byte("needle\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(rootDir, "top.txt"), []byte("needle\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	decoded := callGrep(t, root, grepArgs{Pattern: "needle", Path: "sub"})
	matches := grepMatches(t, decoded)
	if len(matches) != 1 || matches[0]["path"] != "sub/nested.txt" {
		t.Errorf("matches = %v, want exactly sub/nested.txt", matches)
	}
}

func TestGrepGlobFiltersFiles(t *testing.T) {
	requireRG(t)
	root, rootDir := newTestRoot(t)
	if err := os.WriteFile(filepath.Join(rootDir, "a.txt"), []byte("needle\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(rootDir, "b.md"), []byte("needle\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	decoded := callGrep(t, root, grepArgs{Pattern: "needle", Glob: "*.txt"})
	matches := grepMatches(t, decoded)
	if len(matches) != 1 || matches[0]["path"] != "a.txt" {
		t.Errorf("matches = %v, want exactly a.txt", matches)
	}
}

func TestGrepGlobAbsoluteRefused(t *testing.T) {
	root, _ := newTestRoot(t)
	decoded := callGrep(t, root, grepArgs{Pattern: "x", Glob: "/etc/*"})
	if decoded["ok"] != false {
		t.Fatalf("ok = %v, want false", decoded["ok"])
	}
	errObj := decoded["error"].(map[string]any)
	if errObj["code"] != "outside_root" {
		t.Errorf("code = %v, want outside_root", errObj["code"])
	}
}

func TestGrepGlobDotDotRefused(t *testing.T) {
	root, _ := newTestRoot(t)
	decoded := callGrep(t, root, grepArgs{Pattern: "x", Glob: "../*"})
	if decoded["ok"] != false {
		t.Fatalf("ok = %v, want false", decoded["ok"])
	}
	errObj := decoded["error"].(map[string]any)
	if errObj["code"] != "outside_root" {
		t.Errorf("code = %v, want outside_root", errObj["code"])
	}
}

func TestGrepPatternNulByteRefused(t *testing.T) {
	root, _ := newTestRoot(t)
	decoded := callGrep(t, root, grepArgs{Pattern: "a\x00b"})
	if decoded["ok"] != false {
		t.Fatalf("ok = %v, want false", decoded["ok"])
	}
	errObj := decoded["error"].(map[string]any)
	if errObj["code"] != "invalid_argument" {
		t.Errorf("code = %v, want invalid_argument", errObj["code"])
	}
}

func TestGrepInvalidRegexIsRejected(t *testing.T) {
	requireRG(t)
	root, _ := newTestRoot(t)
	decoded := callGrep(t, root, grepArgs{Pattern: "(unclosed"})
	if decoded["ok"] != false {
		t.Fatalf("ok = %v, want false", decoded["ok"])
	}
	errObj := decoded["error"].(map[string]any)
	if errObj["code"] != "invalid_argument" {
		t.Errorf("code = %v, want invalid_argument", errObj["code"])
	}
}

func TestGrepNoMatchIsEmptySuccess(t *testing.T) {
	requireRG(t)
	root, _ := newTestRoot(t)
	decoded := callGrep(t, root, grepArgs{Pattern: "zzz_definitely_not_present_zzz"})
	if decoded["ok"] != true {
		t.Fatalf("ok = %v, want true (a search that matches nothing is a success)", decoded["ok"])
	}
	if matches := grepMatches(t, decoded); len(matches) != 0 {
		t.Errorf("matches = %v, want empty", matches)
	}
}

func TestGrepMissingPathIsError(t *testing.T) {
	root, _ := newTestRoot(t)
	decoded := callGrep(t, root, grepArgs{Pattern: "x", Path: "nosuchdir"})
	if decoded["ok"] != false {
		t.Fatalf("ok = %v, want false — a missing path must never be an empty success", decoded["ok"])
	}
	errObj := decoded["error"].(map[string]any)
	if errObj["code"] != "not_found" {
		t.Errorf("code = %v, want not_found", errObj["code"])
	}
}

func TestGrepUnreadablePathIsError(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("running as root bypasses permission checks")
	}
	root, rootDir := newTestRoot(t)
	locked := filepath.Join(rootDir, "locked")
	if err := os.Mkdir(locked, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(locked, 0); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(locked, 0o755) })

	decoded := callGrep(t, root, grepArgs{Pattern: "x", Path: "locked"})
	if decoded["ok"] != false {
		t.Fatalf("ok = %v, want false — an unreadable path must never be an empty success", decoded["ok"])
	}
	errObj := decoded["error"].(map[string]any)
	if errObj["code"] != "io_error" {
		t.Errorf("code = %v, want io_error", errObj["code"])
	}
}

func TestGrepMaxMatchesTruncates(t *testing.T) {
	requireRG(t)
	root, rootDir := newTestRoot(t)
	var lines strings.Builder
	for i := 0; i < 10; i++ {
		lines.WriteString("needle\n")
	}
	if err := os.WriteFile(filepath.Join(rootDir, "many.txt"), []byte(lines.String()), 0o644); err != nil {
		t.Fatal(err)
	}

	decoded := callGrep(t, root, grepArgs{Pattern: "needle", MaxMatches: intPtr(3)})
	if decoded["ok"] != true {
		t.Fatalf("ok = %v, want true", decoded["ok"])
	}
	if matches := grepMatches(t, decoded); len(matches) != 3 {
		t.Fatalf("matches = %d, want exactly 3", len(matches))
	}
	if decoded["truncated"] != true {
		t.Errorf("truncated = %v, want true", decoded["truncated"])
	}
}

func TestGrepDefaultMaxMatchesIs200(t *testing.T) {
	requireRG(t)
	root, rootDir := newTestRoot(t)
	var lines strings.Builder
	for i := 0; i < 205; i++ {
		lines.WriteString("needle\n")
	}
	if err := os.WriteFile(filepath.Join(rootDir, "many.txt"), []byte(lines.String()), 0o644); err != nil {
		t.Fatal(err)
	}

	decoded := callGrep(t, root, grepArgs{Pattern: "needle"})
	if matches := grepMatches(t, decoded); len(matches) != grepDefaultMaxMatches {
		t.Fatalf("matches = %d, want %d", len(matches), grepDefaultMaxMatches)
	}
	if decoded["truncated"] != true {
		t.Errorf("truncated = %v, want true", decoded["truncated"])
	}
}

func TestGrepMaxMatchesMustBePositive(t *testing.T) {
	root, _ := newTestRoot(t)
	for _, n := range []int{0, -1} {
		decoded := callGrep(t, root, grepArgs{Pattern: "x", MaxMatches: intPtr(n)})
		if decoded["ok"] != false {
			t.Fatalf("max_matches=%d: ok = %v, want false", n, decoded["ok"])
		}
		errObj := decoded["error"].(map[string]any)
		if errObj["code"] != "invalid_argument" {
			t.Errorf("max_matches=%d: code = %v, want invalid_argument", n, errObj["code"])
		}
	}
}

func TestGrepHostileFilenameNewlineIsOneIntactEntry(t *testing.T) {
	requireRG(t)
	root, rootDir := newTestRoot(t)
	if err := os.WriteFile(filepath.Join(rootDir, "we\nird.txt"), []byte("needle\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	decoded := callGrep(t, root, grepArgs{Pattern: "needle"})
	matches := grepMatches(t, decoded)
	if len(matches) != 1 {
		t.Fatalf("matches = %v, want exactly 1", matches)
	}
	if matches[0]["path"] != "we\nird.txt" {
		t.Errorf("path = %q, want one intact entry %q", matches[0]["path"], "we\nird.txt")
	}
}

func TestGrepResultPathsAreCanonical(t *testing.T) {
	requireRG(t)
	root, rootDir := newTestRoot(t)
	if err := os.WriteFile(filepath.Join(rootDir, "top.txt"), []byte("needle\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	decoded := callGrep(t, root, grepArgs{Pattern: "needle"})
	for _, m := range grepMatches(t, decoded) {
		p := m["path"].(string)
		if strings.HasPrefix(p, "./") || strings.HasPrefix(p, "/") {
			t.Errorf("path %q is not canonical (relative, no leading \"./\")", p)
		}
	}
}

func TestGrepTimeoutIsAnErrorNamingTheTimeout(t *testing.T) {
	root, _ := newTestRoot(t)
	withSlowRG(t)

	decoded := callGrep(t, root, grepArgs{Pattern: "x"})
	if decoded["ok"] != false {
		t.Fatalf("ok = %v, want false — a timeout must never be a silent partial", decoded["ok"])
	}
	errObj := decoded["error"].(map[string]any)
	if errObj["code"] != "io_error" {
		t.Errorf("code = %v, want io_error", errObj["code"])
	}
	msg, _ := errObj["message"].(string)
	if !strings.Contains(msg, "timed out") {
		t.Errorf("message = %q, want it to name the timeout", msg)
	}
}

func TestParseMatchesTruncates(t *testing.T) {
	var sb strings.Builder
	for i := 1; i <= 5; i++ {
		sb.WriteString(`{"type":"begin","data":{"path":{"text":"f.txt"}}}` + "\n")
		sb.WriteString(`{"type":"match","data":{"path":{"text":"f.txt"},"lines":{"text":"hit\n"},"line_number":` +
			strconv.Itoa(i) + `}}` + "\n")
	}
	matches, truncated := parseMatches([]byte(sb.String()), 2)
	if !truncated {
		t.Fatal("expected truncated = true")
	}
	if len(matches) != 2 {
		t.Fatalf("matches = %v, want 2 entries", matches)
	}
}

func TestParseMatchesEmpty(t *testing.T) {
	matches, truncated := parseMatches(nil, 10)
	if truncated {
		t.Fatal("expected truncated = false for empty input")
	}
	if len(matches) != 0 {
		t.Fatalf("matches = %v, want empty", matches)
	}
}
