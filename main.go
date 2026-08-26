// Command fsmcp exposes one directory to an MCP client as a rooted
// filesystem, over newline-delimited JSON-RPC 2.0 on stdio. See
// docs/DESIGN.md for the contract.
package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"

	"fsmcp/internal/fsapi"
	"fsmcp/internal/proto"
)

const defaultMaxResponseBytes = 8 * 1024 * 1024 // 8 MiB, coordinated with relay's bridge frame limit.

func main() {
	if err := run(os.Args[1:], os.Stdin, os.Stdout, os.Stderr); err != nil {
		fmt.Fprintln(os.Stderr, "fsmcp:", err)
		os.Exit(1)
	}
}

func run(args []string, stdin io.Reader, stdout, stderr io.Writer) error {
	fs := flag.NewFlagSet("fsmcp", flag.ContinueOnError)
	fs.SetOutput(stderr)
	rootDir := fs.String("root", "", "directory to expose (required)")
	readOnly := fs.Bool("read-only", false, "register only read-only tools")
	maxResponseBytes := fs.Int("max-response-bytes", defaultMaxResponseBytes, "cap on a serialised JSON-RPC response line, in bytes")
	if err := fs.Parse(args); err != nil {
		return err
	}

	if *rootDir == "" {
		return fmt.Errorf("--root is required")
	}
	info, err := os.Stat(*rootDir)
	if err != nil {
		return fmt.Errorf("--root %q: %w", *rootDir, err)
	}
	if !info.IsDir() {
		return fmt.Errorf("--root %q is not a directory", *rootDir)
	}
	if *maxResponseBytes <= 0 {
		return fmt.Errorf("--max-response-bytes must be positive")
	}

	if _, err := exec.LookPath("rg"); err != nil {
		return fmt.Errorf("ripgrep (rg) not found on PATH: %w", err)
	}

	root, err := fsapi.OpenRoot(*rootDir)
	if err != nil {
		return fmt.Errorf("opening root: %w", err)
	}
	defer root.Close()

	reg := fsapi.NewRegistry(root, *readOnly)
	root.SetMaxResponseBytes(*maxResponseBytes)

	fsapi.RegisterStat(reg)
	fsapi.RegisterList(reg)
	fsapi.RegisterRead(reg)
	fsapi.RegisterGlob(reg)
	fsapi.RegisterGrep(reg)
	fsapi.RegisterWrite(reg)
	fsapi.RegisterReplace(reg)
	fsapi.RegisterMkdir(reg)
	fsapi.RegisterMove(reg)
	fsapi.RegisterDelete(reg)

	return serve(stdin, stdout, reg, *maxResponseBytes)
}

// serve runs the newline-delimited JSON-RPC loop until stdin closes.
func serve(stdin io.Reader, stdout io.Writer, reg *fsapi.Registry, maxResponseBytes int) error {
	reader := bufio.NewReader(stdin)
	writer := bufio.NewWriter(stdout)
	defer writer.Flush()

	for {
		line, readErr := reader.ReadBytes('\n')
		if len(bytes.TrimSpace(line)) > 0 {
			handleLine(writer, reg, maxResponseBytes, line)
			if err := writer.Flush(); err != nil {
				return err
			}
		}
		if readErr != nil {
			if readErr == io.EOF {
				return nil
			}
			return readErr
		}
	}
}

func handleLine(w io.Writer, reg *fsapi.Registry, maxResponseBytes int, line []byte) {
	line = bytes.TrimSpace(line)

	var req proto.Request
	if err := json.Unmarshal(line, &req); err != nil {
		writeResponse(w, maxResponseBytes, proto.NewErrorResponse(nil, proto.CodeParseError, "parse error"))
		return
	}

	switch req.Method {
	case "initialize":
		if req.IsNotification() {
			return
		}
		result := proto.InitializeResult{
			ProtocolVersion: proto.ProtocolVersion,
			ServerInfo:      proto.ServerInfo{Name: proto.ServerName, Version: proto.ServerVersion},
		}
		writeResponse(w, maxResponseBytes, proto.NewResultResponse(req.ID, result))

	case "notifications/initialized":
		// Notification: no reply, ever.

	case "tools/list":
		if req.IsNotification() {
			return
		}
		writeResponse(w, maxResponseBytes, proto.NewResultResponse(req.ID, proto.ListToolsResult{Tools: reg.List()}))

	case "tools/call":
		if req.IsNotification() {
			return
		}
		var params proto.CallToolParams
		if err := json.Unmarshal(req.Params, &params); err != nil {
			writeResponse(w, maxResponseBytes, proto.NewErrorResponse(req.ID, proto.CodeInvalidParams, "invalid params"))
			return
		}
		result := reg.Call(params.Name, params.Arguments, params.Meta)
		writeResponse(w, maxResponseBytes, proto.NewResultResponse(req.ID, result))

	default:
		if req.IsNotification() {
			return
		}
		writeResponse(w, maxResponseBytes, proto.NewErrorResponse(req.ID, proto.CodeMethodNotFound, "method not found"))
	}
}

// writeResponse serialises resp and writes it as one line. A line that would
// exceed maxResponseBytes is replaced with a JSON-RPC error rather than
// truncated — a truncated JSON document is not a JSON document.
func writeResponse(w io.Writer, maxResponseBytes int, resp *proto.Response) {
	b, err := json.Marshal(resp)
	if err != nil {
		b, _ = json.Marshal(proto.NewErrorResponse(resp.ID, proto.CodeInternalError, "internal error"))
	}
	if len(b)+1 > maxResponseBytes {
		b, _ = json.Marshal(proto.NewErrorResponse(resp.ID, proto.CodeResponseTooLarge, "response exceeds max-response-bytes"))
	}
	w.Write(b)
	w.Write([]byte("\n"))
}
