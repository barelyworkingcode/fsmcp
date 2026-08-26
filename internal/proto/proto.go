// Package proto holds the JSON-RPC 2.0 wire types, the MCP tool-result
// envelope, and the error taxonomy every tool result is built from.
package proto

import "encoding/json"

// ProtocolVersion is the MCP protocol version this server implements.
const ProtocolVersion = "2024-11-05"

// ServerName and ServerVersion identify this server in "initialize".
const (
	ServerName    = "fsmcp"
	ServerVersion = "3.0.0"
)

// JSON-RPC 2.0 standard error codes.
const (
	CodeParseError     = -32700
	CodeInvalidRequest = -32600
	CodeMethodNotFound = -32601
	CodeInvalidParams  = -32602
	CodeInternalError  = -32603
)

// CodeResponseTooLarge is implementation-defined, in the JSON-RPC
// server-error range, for the --max-response-bytes backstop: a line that
// would exceed the cap is replaced with this error rather than truncated.
const CodeResponseTooLarge = -32000

// CodeRequestTooLarge is the mirror of CodeResponseTooLarge for the inbound
// direction: a frame longer than --max-request-bytes is refused rather than
// accumulated. Distinct from CodeResponseTooLarge so an operator can tell
// "this server would not say that much" from "this client said too much".
const CodeRequestTooLarge = -32001

// Request is an incoming JSON-RPC 2.0 message. ID is absent (nil) for a
// notification, which never gets a reply, not even an error.
type Request struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

// IsNotification reports whether the request carries no id.
func (r Request) IsNotification() bool { return len(r.ID) == 0 }

// Response is an outgoing JSON-RPC 2.0 message: exactly one of Result/Error
// is set.
type Response struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *RPCError       `json:"error,omitempty"`
}

// RPCError is a JSON-RPC 2.0 protocol-level error (as opposed to a tool
// result's {"ok":false,"error":{...}} shape).
type RPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// NewResultResponse builds a successful JSON-RPC response.
func NewResultResponse(id json.RawMessage, result any) *Response {
	return &Response{JSONRPC: "2.0", ID: id, Result: result}
}

// NewErrorResponse builds a JSON-RPC protocol-level error response.
func NewErrorResponse(id json.RawMessage, code int, message string) *Response {
	return &Response{JSONRPC: "2.0", ID: id, Error: &RPCError{Code: code, Message: message}}
}

// --- initialize ---

// ServerInfo identifies this server.
type ServerInfo struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

// ToolsCapability is always the empty object: this server advertises tool
// support and nothing else. No contextSchema — scope is fixed at spawn.
type ToolsCapability struct{}

// Capabilities is the "capabilities" field of an initialize result.
type Capabilities struct {
	Tools ToolsCapability `json:"tools"`
}

// InitializeResult is the result of the "initialize" method.
type InitializeResult struct {
	ProtocolVersion string       `json:"protocolVersion"`
	ServerInfo      ServerInfo   `json:"serverInfo"`
	Capabilities    Capabilities `json:"capabilities"`
}

// --- tools/list ---

// ToolAnnotations are the hints relay and other clients gate on.
// readOnlyHint/openWorldHint are required, not optional, on every tool: a
// hint that is merely absent must never be mistaken for false.
type ToolAnnotations struct {
	ReadOnlyHint  bool `json:"readOnlyHint"`
	OpenWorldHint bool `json:"openWorldHint"`
}

// Tool describes one callable tool for "tools/list".
type Tool struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	InputSchema json.RawMessage `json:"inputSchema"`
	Annotations ToolAnnotations `json:"annotations"`
}

// ListToolsResult is the result of the "tools/list" method.
type ListToolsResult struct {
	Tools []Tool `json:"tools"`
}

// --- tools/call ---

// CallToolParams is the params object of a "tools/call" request. Arguments
// is held as json.RawMessage and must never be decoded before the
// _meta.args_sha256 check runs — decoding first would hash something other
// than the bytes the caller actually sent.
type CallToolParams struct {
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments"`
	Meta      *Meta           `json:"_meta,omitempty"`
}

// Meta is the "_meta" field of a tools/call request.
type Meta struct {
	// ArgsSHA256, when present, must equal sha256(Arguments) exactly as
	// received. Verified when present, not required — see DESIGN.md.
	ArgsSHA256 string `json:"args_sha256,omitempty"`
}

// ContentBlock is one block of an MCP tool result. Every tool result in this
// server has exactly one, of type "text".
type ContentBlock struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

// CallToolResult is the result of a "tools/call" method.
type CallToolResult struct {
	Content []ContentBlock `json:"content"`
	IsError bool           `json:"isError,omitempty"`
	Meta    map[string]any `json:"_meta,omitempty"`
}

// --- tool result envelope: {"ok":true,...} / {"ok":false,"error":{...}} ---

// ErrorCode is one of the fixed taxonomy of tool-result error codes.
type ErrorCode string

// The complete error taxonomy. No tool result ever carries a code outside
// this set.
const (
	ErrInvalidArgument    ErrorCode = "invalid_argument"
	ErrOutsideRoot        ErrorCode = "outside_root"
	ErrNotFound           ErrorCode = "not_found"
	ErrExists             ErrorCode = "exists"
	ErrNotAFile           ErrorCode = "not_a_file"
	ErrNotADir            ErrorCode = "not_a_dir"
	ErrPreconditionFailed ErrorCode = "precondition_failed"
	ErrNoMatch            ErrorCode = "no_match"
	ErrAmbiguousMatch     ErrorCode = "ambiguous_match"
	ErrTooLarge           ErrorCode = "too_large"
	ErrReadOnly           ErrorCode = "read_only"
	ErrIntegrityFailed    ErrorCode = "integrity_failed"
	ErrIOError            ErrorCode = "io_error"
)

// ErrorInfo is the JSON shape of a failed tool call's "error" field.
type ErrorInfo struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Path    string `json:"path,omitempty"`
}

type errorEnvelope struct {
	OK    bool      `json:"ok"`
	Error ErrorInfo `json:"error"`
}

// NewSuccessResult wraps v — which must itself carry `"ok":true` via an
// exported OK bool field — as the tool's single text content block.
func NewSuccessResult(v any) *CallToolResult {
	b, err := json.Marshal(v)
	if err != nil {
		return NewErrorResult(ErrIOError, "failed to encode result", "")
	}
	return &CallToolResult{Content: []ContentBlock{{Type: "text", Text: string(b)}}}
}

// NewErrorResult builds a failed tool result. message is written by the
// caller, never derived from a raw Go error — that separation is the whole
// defence against a host path leaking into a reply. path, when non-empty,
// must already be a caller-known, canonical relative path.
func NewErrorResult(code ErrorCode, message, path string) *CallToolResult {
	env := errorEnvelope{OK: false, Error: ErrorInfo{Code: string(code), Message: message, Path: path}}
	b, err := json.Marshal(env)
	if err != nil {
		// Only unencodable input (e.g. invalid UTF-8 forced through) could
		// get here; fall back to a static, always-valid payload.
		b = []byte(`{"ok":false,"error":{"code":"io_error","message":"failed to encode error"}}`)
	}
	res := &CallToolResult{Content: []ContentBlock{{Type: "text", Text: string(b)}}, IsError: true}
	if code == ErrOutsideRoot {
		// Relay reads this marker to tell a containment refusal apart from an
		// ordinary tool failure in its audit log. Both are isError, so without
		// it an operator cannot see that the boundary held.
		res.Meta = map[string]any{"scope_violation": true}
	}
	return res
}
