package fsapi

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"

	"fsmcp/internal/proto"
)

// Handler implements one tool. It receives the shared Root and the tool's
// arguments as raw, undecoded JSON bytes — decoding is each handler's own
// job, after the registry's integrity check has already run.
type Handler func(root *Root, args json.RawMessage) *proto.CallToolResult

type toolEntry struct {
	tool    proto.Tool
	handler Handler
}

// Registry holds the set of tools this server instance exposes.
type Registry struct {
	root     *Root
	readOnly bool
	entries  map[string]toolEntry
	order    []string
}

// NewRegistry creates an empty registry bound to root. When readOnly is
// true, Register silently declines any tool not annotated ReadOnlyHint —
// DESIGN.md's "--read-only registers only those" is a registration-time
// decision, not a per-call check.
func NewRegistry(root *Root, readOnly bool) *Registry {
	return &Registry{
		root:     root,
		readOnly: readOnly,
		entries:  make(map[string]toolEntry),
	}
}

// Register adds a tool, unless --read-only excludes it.
func (r *Registry) Register(tool proto.Tool, h Handler) {
	if r.readOnly && !tool.Annotations.ReadOnlyHint {
		return
	}
	r.entries[tool.Name] = toolEntry{tool: tool, handler: h}
	r.order = append(r.order, tool.Name)
}

// List returns the registered tools in registration order.
func (r *Registry) List() []proto.Tool {
	tools := make([]proto.Tool, 0, len(r.order))
	for _, name := range r.order {
		tools = append(tools, r.entries[name].tool)
	}
	return tools
}

// Call verifies _meta.args_sha256 when present, then dispatches to the
// named tool. A hash mismatch or an unknown tool name never reaches a
// handler.
func (r *Registry) Call(name string, args json.RawMessage, meta *proto.Meta) (result *proto.CallToolResult) {
	if meta != nil && meta.ArgsSHA256 != "" {
		sum := sha256.Sum256(args)
		if hex.EncodeToString(sum[:]) != meta.ArgsSHA256 {
			return proto.NewErrorResult(proto.ErrIntegrityFailed, "arguments hash does not match _meta.args_sha256", "")
		}
	}

	entry, ok := r.entries[name]
	if !ok {
		return proto.NewErrorResult(proto.ErrInvalidArgument, "unknown tool: "+name, "")
	}

	// This is deliberate: a handler panic is caught here, centrally, so one
	// bad call is an io_error rather than the process going down under
	// every other in-flight and future call.
	defer func() {
		if rec := recover(); rec != nil {
			result = proto.NewErrorResult(proto.ErrIOError, "internal error handling this call", "")
		}
	}()
	return entry.handler(r.root, args)
}
