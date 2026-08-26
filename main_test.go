package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"

	"fsmcp/internal/fsapi"
	"fsmcp/internal/proto"
)

// newTestRootDir builds a minimal on-disk root for driving run()/serve()
// end to end, the way the real binary is driven over stdio.
func newTestRootDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "file.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

// rpcLines splits stdout into its newline-delimited JSON-RPC messages,
// decoded generically.
func rpcLines(t *testing.T, out string) []map[string]any {
	t.Helper()
	var lines []map[string]any
	for _, l := range strings.Split(strings.TrimRight(out, "\n"), "\n") {
		if strings.TrimSpace(l) == "" {
			continue
		}
		var decoded map[string]any
		if err := json.Unmarshal([]byte(l), &decoded); err != nil {
			t.Fatalf("line not valid JSON: %v\nline: %s", err, l)
		}
		lines = append(lines, decoded)
	}
	return lines
}

func runCapture(t *testing.T, args []string, stdin string) string {
	t.Helper()
	var stdout, stderr bytes.Buffer
	if err := run(args, strings.NewReader(stdin), &stdout, &stderr); err != nil {
		t.Fatalf("run: %v (stderr: %s)", err, stderr.String())
	}
	return stdout.String()
}

func toolsListRequest(id int) string {
	return `{"jsonrpc":"2.0","id":` + strconv.Itoa(id) + `,"method":"tools/list","params":{}}`
}

// TestToolsListAnnotationsAlwaysExplicit is H1: every tool the real binary
// registers publishes readOnlyHint and openWorldHint as explicit booleans.
func TestToolsListAnnotationsAlwaysExplicit(t *testing.T) {
	dir := newTestRootDir(t)
	out := runCapture(t, []string{"--root", dir}, toolsListRequest(1)+"\n")
	lines := rpcLines(t, out)
	if len(lines) != 1 {
		t.Fatalf("got %d lines, want 1", len(lines))
	}
	result := lines[0]["result"].(map[string]any)
	tools := result["tools"].([]any)
	if len(tools) == 0 {
		t.Fatal("no tools registered")
	}
	for _, raw := range tools {
		tool := raw.(map[string]any)
		ann, ok := tool["annotations"].(map[string]any)
		if !ok {
			t.Fatalf("tool %v has no annotations object", tool["name"])
		}
		if _, ok := ann["readOnlyHint"].(bool); !ok {
			t.Errorf("tool %v: readOnlyHint missing or not a boolean: %v", tool["name"], ann["readOnlyHint"])
		}
		if _, ok := ann["openWorldHint"].(bool); !ok {
			t.Errorf("tool %v: openWorldHint missing or not a boolean: %v", tool["name"], ann["openWorldHint"])
		}
	}
}

// TestReadOnlyFlagRegistersExactlyFiveReadOnlyTools is H2: --read-only
// registers exactly the five readOnlyHint: true tools, and a write tool is
// then absent from tools/list — not merely refused when called.
func TestReadOnlyFlagRegistersExactlyFiveReadOnlyTools(t *testing.T) {
	dir := newTestRootDir(t)

	fullOut := runCapture(t, []string{"--root", dir}, toolsListRequest(1)+"\n")
	fullNames := toolNames(t, fullOut)
	if len(fullNames) != 10 {
		t.Fatalf("without --read-only: got %d tools, want 10: %v", len(fullNames), fullNames)
	}
	if !fullNames["fs_write"] {
		t.Fatal("without --read-only: fs_write is not registered")
	}

	roOut := runCapture(t, []string{"--root", dir, "--read-only"}, toolsListRequest(1)+"\n")
	roNames := toolNames(t, roOut)
	want := map[string]bool{"fs_stat": true, "fs_list": true, "fs_read": true, "fs_glob": true, "fs_grep": true}
	if len(roNames) != len(want) {
		t.Fatalf("--read-only: got %d tools, want %d: %v", len(roNames), len(want), roNames)
	}
	for name := range want {
		if !roNames[name] {
			t.Errorf("--read-only: %s missing from tools/list", name)
		}
	}
	if roNames["fs_write"] {
		t.Error("--read-only: fs_write is registered, want absent from tools/list entirely")
	}
}

func toolNames(t *testing.T, out string) map[string]bool {
	t.Helper()
	lines := rpcLines(t, out)
	result := lines[0]["result"].(map[string]any)
	tools := result["tools"].([]any)
	names := map[string]bool{}
	for _, raw := range tools {
		tool := raw.(map[string]any)
		names[tool["name"].(string)] = true
	}
	return names
}

// TestOverBudgetResponseBecomesJSONRPCError is H3: a response that would
// exceed --max-response-bytes becomes a JSON-RPC error line, never a
// truncated (and therefore invalid) line.
func TestOverBudgetResponseBecomesJSONRPCError(t *testing.T) {
	dir := newTestRootDir(t)
	out := runCapture(t, []string{"--root", dir, "--max-response-bytes", "40"}, toolsListRequest(1)+"\n")
	lines := rpcLines(t, out) // rpcLines itself fails the test if any line is not valid JSON
	if len(lines) != 1 {
		t.Fatalf("got %d lines, want 1", len(lines))
	}
	if _, hasResult := lines[0]["result"]; hasResult {
		t.Fatalf("expected an error response over budget, got a result: %v", lines[0])
	}
	errObj, ok := lines[0]["error"].(map[string]any)
	if !ok {
		t.Fatalf("no error object: %v", lines[0])
	}
	if int(errObj["code"].(float64)) != proto.CodeResponseTooLarge {
		t.Errorf("error code = %v, want %d", errObj["code"], proto.CodeResponseTooLarge)
	}
}

// TestMalformedJSONIsParseErrorAndServerStaysUp is H4: malformed JSON on
// stdin gets a -32700 response, and the server keeps serving later lines
// on the same connection.
func TestMalformedJSONIsParseErrorAndServerStaysUp(t *testing.T) {
	dir := newTestRootDir(t)
	stdin := "not json at all\n" + toolsListRequest(1) + "\n"
	out := runCapture(t, []string{"--root", dir}, stdin)
	lines := rpcLines(t, out)
	if len(lines) != 2 {
		t.Fatalf("got %d lines, want 2 (one per input line): %v", len(lines), lines)
	}
	errObj, ok := lines[0]["error"].(map[string]any)
	if !ok {
		t.Fatalf("first line: no error object: %v", lines[0])
	}
	if int(errObj["code"].(float64)) != proto.CodeParseError {
		t.Errorf("first line error code = %v, want %d", errObj["code"], proto.CodeParseError)
	}
	if _, hasResult := lines[1]["result"]; !hasResult {
		t.Fatalf("second line: server did not answer the next request after the parse error: %v", lines[1])
	}
}

// TestUnknownMethodAndNotificationHandling is H5: an unknown method with an
// id gets -32601; a notification (no id) gets no reply at all, ever.
func TestUnknownMethodAndNotificationHandling(t *testing.T) {
	dir := newTestRootDir(t)
	stdin := `{"jsonrpc":"2.0","id":1,"method":"bogus/method"}` + "\n" +
		`{"jsonrpc":"2.0","method":"bogus/notify"}` + "\n" +
		toolsListRequest(2) + "\n"
	out := runCapture(t, []string{"--root", dir}, stdin)
	lines := rpcLines(t, out)
	if len(lines) != 2 {
		t.Fatalf("got %d lines, want 2 (the notification must draw no reply): %v", len(lines), lines)
	}
	errObj, ok := lines[0]["error"].(map[string]any)
	if !ok {
		t.Fatalf("first line: no error object: %v", lines[0])
	}
	if int(errObj["code"].(float64)) != proto.CodeMethodNotFound {
		t.Errorf("first line error code = %v, want %d", errObj["code"], proto.CodeMethodNotFound)
	}
	if _, hasResult := lines[1]["result"]; !hasResult {
		t.Fatalf("second line: expected the tools/list result: %v", lines[1])
	}
}

// TestPanicInOneCallDoesNotKillServer is H8, driven through the real
// stdio-facing serve() loop: a handler that panics must come back as
// io_error, and the very same connection must go on serving the next call
// normally — one bad call never takes the server down.
func TestPanicInOneCallDoesNotKillServer(t *testing.T) {
	dir := newTestRootDir(t)
	root, err := fsapi.OpenRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()

	reg := fsapi.NewRegistry(root, false)
	reg.Register(proto.Tool{
		Name:        "fs_boom",
		Description: "panics, for H8",
		InputSchema: json.RawMessage(`{"type":"object"}`),
		Annotations: proto.ToolAnnotations{ReadOnlyHint: true, OpenWorldHint: false},
	}, func(root *fsapi.Root, args json.RawMessage) *proto.CallToolResult {
		panic("simulated handler bug")
	})
	fsapi.RegisterStat(reg)

	stdin := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"fs_boom","arguments":{}}}` + "\n" +
		`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"fs_stat","arguments":{"path":"file.txt"}}}` + "\n"

	var stdout bytes.Buffer
	if err := serve(strings.NewReader(stdin), &stdout, reg, defaultMaxRequestBytes, fsapi.DefaultMaxResponseBytes); err != nil {
		t.Fatalf("serve: %v", err)
	}
	lines := rpcLines(t, stdout.String())
	if len(lines) != 2 {
		t.Fatalf("got %d lines, want 2: %v", len(lines), lines)
	}

	firstResult := lines[0]["result"].(map[string]any)
	firstContent := firstResult["content"].([]any)[0].(map[string]any)
	var firstPayload map[string]any
	if err := json.Unmarshal([]byte(firstContent["text"].(string)), &firstPayload); err != nil {
		t.Fatalf("fs_boom content not valid JSON: %v", err)
	}
	if firstPayload["ok"] != false {
		t.Fatalf("fs_boom call: ok = %v, want false", firstPayload["ok"])
	}
	if code := firstPayload["error"].(map[string]any)["code"]; code != "io_error" {
		t.Errorf("fs_boom call: error code = %v, want io_error", code)
	}

	secondResult := lines[1]["result"].(map[string]any)
	secondContent := secondResult["content"].([]any)[0].(map[string]any)
	var secondPayload map[string]any
	if err := json.Unmarshal([]byte(secondContent["text"].(string)), &secondPayload); err != nil {
		t.Fatalf("fs_stat content not valid JSON: %v", err)
	}
	if secondPayload["ok"] != true {
		t.Fatalf("fs_stat call after a panic: ok = %v, want true (%v)", secondPayload["ok"], secondPayload)
	}
}

// --- the inbound bound (mirror of --max-response-bytes) ---

// An oversized frame must be refused, and the SESSION must survive it. Frames
// are newline-delimited, so the reader has to drain the offending line to its
// terminator and pick up at the next one — otherwise one bad frame desynchronises
// every call after it, which is worse than the allocation the bound prevents.
func TestServeRefusesAnOversizedFrameAndResyncs(t *testing.T) {
	rootDir := newTestRootDir(t)
	root, err := fsapi.OpenRoot(rootDir)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	reg := fsapi.NewRegistry(root, false)
	fsapi.RegisterStat(reg)

	const limit = 4096
	huge := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"fs_stat","arguments":{"path":"` +
		strings.Repeat("A", limit*4) + `"}}}`
	after := `{"jsonrpc":"2.0","id":2,"method":"tools/list"}`

	var stdout bytes.Buffer
	if err := serve(strings.NewReader(huge+"\n"+after+"\n"), &stdout, reg, limit, fsapi.DefaultMaxResponseBytes); err != nil {
		t.Fatalf("serve: %v", err)
	}

	lines := strings.Split(strings.TrimSpace(stdout.String()), "\n")
	if len(lines) != 2 {
		t.Fatalf("got %d responses, want 2 (the refusal and the call after it):\n%s", len(lines), stdout.String())
	}

	var refusal proto.Response
	if err := json.Unmarshal([]byte(lines[0]), &refusal); err != nil {
		t.Fatal(err)
	}
	if refusal.Error == nil || refusal.Error.Code != proto.CodeRequestTooLarge {
		t.Errorf("first response = %s, want a CodeRequestTooLarge error", lines[0])
	}

	// The whole point of resyncing: the NEXT request is served normally.
	var served proto.Response
	if err := json.Unmarshal([]byte(lines[1]), &served); err != nil {
		t.Fatal(err)
	}
	if served.Error != nil {
		t.Errorf("the request after an oversized one failed: %s", lines[1])
	}
	if string(served.ID) != "2" {
		t.Errorf("second response id = %s, want 2 — the stream did not resync", served.ID)
	}
}

// A frame at the limit is accepted; one byte past it is not. Pinned because an
// off-by-one here either rejects legitimate maximum-size calls from relay or
// leaves the bound a byte looser than it says.
func TestReadFrameBoundaryIsExact(t *testing.T) {
	const max = 64
	for _, tc := range []struct {
		name         string
		size         int
		wantOversize bool
	}{
		{"one under", max - 1, false},
		{"exactly at the limit", max, false},
		{"one over", max + 1, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			// The newline is the terminator, not part of the frame.
			payload := strings.Repeat("x", tc.size)
			r := bufio.NewReader(strings.NewReader(payload + "\n"))
			line, oversized, err := readFrame(r, max)
			if err != nil && err != io.EOF {
				t.Fatalf("readFrame: %v", err)
			}
			if oversized != tc.wantOversize {
				t.Errorf("oversized = %v, want %v (frame was %d bytes, limit %d)", oversized, tc.wantOversize, tc.size, max)
			}
			if !oversized && len(strings.TrimSpace(string(line))) != tc.size {
				t.Errorf("line length = %d, want %d", len(strings.TrimSpace(string(line))), tc.size)
			}
			if oversized && line != nil {
				t.Errorf("an oversized frame returned %d bytes; it must retain nothing", len(line))
			}
		})
	}
}

// Refusing must be cheap, or the bound has only moved the cost. The frame here
// is far larger than the limit, and the allocation must track the limit rather
// than the frame.
func TestReadFrameDoesNotAccumulateAnOversizedLine(t *testing.T) {
	const max = 4096
	const frame = 64 << 20 // 64 MiB, four orders of magnitude past the limit

	r := bufio.NewReader(strings.NewReader(strings.Repeat("x", frame) + "\n"))

	var before, after runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&before)
	_, oversized, err := readFrame(r, max)
	runtime.ReadMemStats(&after)

	if err != nil && err != io.EOF {
		t.Fatalf("readFrame: %v", err)
	}
	if !oversized {
		t.Fatal("a 64 MiB frame was not reported oversized")
	}
	allocated := after.TotalAlloc - before.TotalAlloc
	t.Logf("draining a %d MiB frame allocated %d KiB", frame>>20, allocated>>10)
	if allocated > frame/8 {
		t.Errorf("draining allocated %d bytes for a %d byte frame — it is accumulating what it refuses", allocated, frame)
	}
}
