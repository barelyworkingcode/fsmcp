package proto

import (
	"encoding/json"
	"testing"
)

func TestRequestIsNotification(t *testing.T) {
	cases := []struct {
		name string
		json string
		want bool
	}{
		{"with numeric id", `{"jsonrpc":"2.0","id":1,"method":"initialize"}`, false},
		{"with string id", `{"jsonrpc":"2.0","id":"a","method":"initialize"}`, false},
		{"without id", `{"jsonrpc":"2.0","method":"notifications/initialized"}`, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var req Request
			if err := json.Unmarshal([]byte(tc.json), &req); err != nil {
				t.Fatalf("unmarshal: %v", err)
			}
			if got := req.IsNotification(); got != tc.want {
				t.Errorf("IsNotification() = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestCallToolParamsArgumentsStayRaw(t *testing.T) {
	// Arguments must round-trip byte-for-byte: it is hashed before anything
	// decodes it, so re-serialising it here would defeat the whole point.
	raw := `{"name":"fs_stat","arguments":{"path":"a.txt","z":1,"a":2}}`
	var params CallToolParams
	if err := json.Unmarshal([]byte(raw), &params); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	want := `{"path":"a.txt","z":1,"a":2}`
	if string(params.Arguments) != want {
		t.Errorf("Arguments = %s, want %s", params.Arguments, want)
	}
}

func TestCallToolParamsMeta(t *testing.T) {
	raw := `{"name":"fs_stat","arguments":{},"_meta":{"args_sha256":"deadbeef"}}`
	var params CallToolParams
	if err := json.Unmarshal([]byte(raw), &params); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if params.Meta == nil {
		t.Fatal("Meta is nil")
	}
	if params.Meta.ArgsSHA256 != "deadbeef" {
		t.Errorf("ArgsSHA256 = %q, want %q", params.Meta.ArgsSHA256, "deadbeef")
	}
}

func TestNewResultResponseOmitsError(t *testing.T) {
	resp := NewResultResponse(json.RawMessage(`1`), map[string]string{"a": "b"})
	b, err := json.Marshal(resp)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var decoded map[string]json.RawMessage
	if err := json.Unmarshal(b, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if _, ok := decoded["error"]; ok {
		t.Errorf("result response must not carry an error field, got %s", b)
	}
	if _, ok := decoded["result"]; !ok {
		t.Errorf("result response must carry a result field, got %s", b)
	}
}

func TestNewErrorResponseOmitsResult(t *testing.T) {
	resp := NewErrorResponse(json.RawMessage(`1`), CodeMethodNotFound, "method not found")
	b, err := json.Marshal(resp)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var decoded map[string]json.RawMessage
	if err := json.Unmarshal(b, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if _, ok := decoded["result"]; ok {
		t.Errorf("error response must not carry a result field, got %s", b)
	}
	var rpcErr RPCError
	if err := json.Unmarshal(decoded["error"], &rpcErr); err != nil {
		t.Fatalf("unmarshal error field: %v", err)
	}
	if rpcErr.Code != CodeMethodNotFound || rpcErr.Message != "method not found" {
		t.Errorf("error = %+v, want code %d message %q", rpcErr, CodeMethodNotFound, "method not found")
	}
}

func TestNewSuccessResultShape(t *testing.T) {
	type payload struct {
		OK   bool   `json:"ok"`
		Path string `json:"path"`
	}
	result := NewSuccessResult(payload{OK: true, Path: "notes/x.md"})
	if result.IsError {
		t.Error("success result must not set isError")
	}
	if len(result.Content) != 1 || result.Content[0].Type != "text" {
		t.Fatalf("unexpected content: %+v", result.Content)
	}
	var decoded map[string]any
	if err := json.Unmarshal([]byte(result.Content[0].Text), &decoded); err != nil {
		t.Fatalf("content is not valid JSON: %v", err)
	}
	if decoded["ok"] != true {
		t.Errorf("decoded ok = %v, want true", decoded["ok"])
	}
	if decoded["path"] != "notes/x.md" {
		t.Errorf("decoded path = %v, want notes/x.md", decoded["path"])
	}
}

func TestNewErrorResultShape(t *testing.T) {
	result := NewErrorResult(ErrNotFound, "no such file or directory", "notes/x.md")
	if !result.IsError {
		t.Error("error result must set isError")
	}
	if len(result.Content) != 1 || result.Content[0].Type != "text" {
		t.Fatalf("unexpected content: %+v", result.Content)
	}
	var decoded struct {
		OK    bool      `json:"ok"`
		Error ErrorInfo `json:"error"`
	}
	if err := json.Unmarshal([]byte(result.Content[0].Text), &decoded); err != nil {
		t.Fatalf("content is not valid JSON: %v", err)
	}
	if decoded.OK {
		t.Error("decoded ok = true, want false")
	}
	if decoded.Error.Code != string(ErrNotFound) {
		t.Errorf("decoded code = %q, want %q", decoded.Error.Code, ErrNotFound)
	}
	if decoded.Error.Path != "notes/x.md" {
		t.Errorf("decoded path = %q, want notes/x.md", decoded.Error.Path)
	}
}

func TestErrorTaxonomyCodes(t *testing.T) {
	// The exact set and spelling from DESIGN.md's "Error codes" section.
	want := map[ErrorCode]string{
		ErrInvalidArgument:    "invalid_argument",
		ErrOutsideRoot:        "outside_root",
		ErrNotFound:           "not_found",
		ErrExists:             "exists",
		ErrNotAFile:           "not_a_file",
		ErrNotADir:            "not_a_dir",
		ErrPreconditionFailed: "precondition_failed",
		ErrNoMatch:            "no_match",
		ErrAmbiguousMatch:     "ambiguous_match",
		ErrTooLarge:           "too_large",
		ErrReadOnly:           "read_only",
		ErrIntegrityFailed:    "integrity_failed",
		ErrIOError:            "io_error",
	}
	for code, str := range want {
		if string(code) != str {
			t.Errorf("code %v = %q, want %q", code, string(code), str)
		}
	}
	if len(want) != 13 {
		t.Errorf("expected 13 taxonomy codes, test table has %d", len(want))
	}
}

func TestToolAnnotationsAlwaysPresent(t *testing.T) {
	tool := Tool{
		Name:        "fs_stat",
		Description: "d",
		InputSchema: json.RawMessage(`{}`),
		Annotations: ToolAnnotations{ReadOnlyHint: true, OpenWorldHint: false},
	}
	b, err := json.Marshal(tool)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var decoded map[string]json.RawMessage
	if err := json.Unmarshal(b, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if _, ok := decoded["annotations"]; !ok {
		t.Error("annotations field must always be present, even when both hints are false")
	}
}
