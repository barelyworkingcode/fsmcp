package fsapi

import (
	"encoding/json"
	"testing"

	"fsmcp/internal/proto"
)

// TestRegistryArgsSHA256MismatchRefusesIntegrityFailed is H6: a mismatched
// _meta.args_sha256 must be refused before the handler ever runs.
func TestRegistryArgsSHA256MismatchRefusesIntegrityFailed(t *testing.T) {
	root, _ := newTestRoot(t)
	reg := NewRegistry(root, false)
	called := false
	reg.Register(proto.Tool{Name: "fs_stat", Annotations: proto.ToolAnnotations{ReadOnlyHint: true}}, func(root *Root, args json.RawMessage) *proto.CallToolResult {
		called = true
		return proto.NewSuccessResult(struct {
			OK bool `json:"ok"`
		}{true})
	})

	args := json.RawMessage(`{"path":"file.txt"}`)
	result := reg.Call("fs_stat", args, &proto.Meta{ArgsSHA256: "0000000000000000000000000000000000000000000000000000000000000"})
	assertErrorCode(t, result, "integrity_failed")
	if called {
		t.Error("handler ran despite a hash mismatch")
	}
}

// TestRegistryArgsSHA256AbsentProceedsNormally is H7: no _meta.args_sha256
// at all means no check is performed, and the call proceeds as usual.
func TestRegistryArgsSHA256AbsentProceedsNormally(t *testing.T) {
	root, _ := newTestRoot(t)
	reg := NewRegistry(root, false)
	called := false
	reg.Register(proto.Tool{Name: "fs_stat", Annotations: proto.ToolAnnotations{ReadOnlyHint: true}}, func(root *Root, args json.RawMessage) *proto.CallToolResult {
		called = true
		return proto.NewSuccessResult(struct {
			OK bool `json:"ok"`
		}{true})
	})

	result := reg.Call("fs_stat", json.RawMessage(`{}`), nil)
	if !called {
		t.Fatal("handler did not run when _meta was absent")
	}
	var decoded map[string]any
	if err := json.Unmarshal([]byte(result.Content[0].Text), &decoded); err != nil {
		t.Fatalf("content not valid JSON: %v", err)
	}
	if decoded["ok"] != true {
		t.Errorf("ok = %v, want true", decoded["ok"])
	}
}

// TestRegistryArgsSHA256MatchProceedsNormally proves the positive side of
// H6/H7 together: a hash that does match is not itself a reason to refuse.
func TestRegistryArgsSHA256MatchProceedsNormally(t *testing.T) {
	root, _ := newTestRoot(t)
	reg := NewRegistry(root, false)
	reg.Register(proto.Tool{Name: "fs_stat", Annotations: proto.ToolAnnotations{ReadOnlyHint: true}}, func(root *Root, args json.RawMessage) *proto.CallToolResult {
		return proto.NewSuccessResult(struct {
			OK bool `json:"ok"`
		}{true})
	})

	args := json.RawMessage(`{}`)
	result := reg.Call("fs_stat", args, &proto.Meta{ArgsSHA256: sha256Hex(t, args)})
	var decoded map[string]any
	if err := json.Unmarshal([]byte(result.Content[0].Text), &decoded); err != nil {
		t.Fatalf("content not valid JSON: %v", err)
	}
	if decoded["ok"] != true {
		t.Errorf("ok = %v, want true", decoded["ok"])
	}
}

// TestRegistryPanicInHandlerIsCaughtAsIOError is H8: a handler panic must
// not propagate out of Call, and a later call must still work — one bad
// call never takes the server down.
func TestRegistryPanicInHandlerIsCaughtAsIOError(t *testing.T) {
	root, _ := newTestRoot(t)
	reg := NewRegistry(root, false)
	reg.Register(proto.Tool{Name: "fs_boom", Annotations: proto.ToolAnnotations{ReadOnlyHint: true}}, func(root *Root, args json.RawMessage) *proto.CallToolResult {
		panic("simulated handler bug")
	})
	reg.Register(proto.Tool{Name: "fs_stat", Annotations: proto.ToolAnnotations{ReadOnlyHint: true}}, func(root *Root, args json.RawMessage) *proto.CallToolResult {
		return proto.NewSuccessResult(struct {
			OK bool `json:"ok"`
		}{true})
	})

	result := reg.Call("fs_boom", json.RawMessage(`{}`), nil)
	assertErrorCode(t, result, "io_error")

	// The server itself — this Registry — must still answer the next call.
	next := reg.Call("fs_stat", json.RawMessage(`{}`), nil)
	var decoded map[string]any
	if err := json.Unmarshal([]byte(next.Content[0].Text), &decoded); err != nil {
		t.Fatalf("content not valid JSON: %v", err)
	}
	if decoded["ok"] != true {
		t.Errorf("call after a panic: ok = %v, want true", decoded["ok"])
	}
}

func TestRegistryUnknownToolRefused(t *testing.T) {
	root, _ := newTestRoot(t)
	reg := NewRegistry(root, false)
	result := reg.Call("fs_no_such_tool", json.RawMessage(`{}`), nil)
	assertErrorCode(t, result, "invalid_argument")
}
