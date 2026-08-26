// Package fsapi implements the rooted filesystem surface fsMCP exposes: a
// single *os.Root opened once at startup, path normalisation on top of it,
// and the tool registry that dispatches onto it.
package fsapi

import (
	"errors"
	"io/fs"
	"os"
	"strconv"
	"strings"

	"fsmcp/internal/proto"
)

// ErrInvalidPath marks caller input that is malformed rather than
// out of scope — a NUL byte, which no filesystem path can contain.
// Deliberately not ErrOutsideRoot: conflating malformed input with a
// containment event makes outside_root useless as a signal that something
// actually tried to leave.
var ErrInvalidPath = errors.New("invalid path")

// Root is the sole gateway to the filesystem. Every operation in this
// package goes through the one *os.Root opened at startup, so containment
// is enforced by openat-based kernel resolution, never by string checks
// here.
type Root struct {
	inner            *os.Root
	maxResponseBytes int
}

// DefaultMaxResponseBytes is the budget a Root carries when none is set.
const DefaultMaxResponseBytes = 8 * 1024 * 1024

// OpenRoot opens dir once, for the lifetime of the process.
func OpenRoot(dir string) (*Root, error) {
	r, err := os.OpenRoot(dir)
	if err != nil {
		return nil, err
	}
	return &Root{inner: r, maxResponseBytes: DefaultMaxResponseBytes}, nil
}

// SetMaxResponseBytes carries the operator's --max-response-bytes to the tools
// that must size a reply against it. It lives on Root rather than in the
// Handler signature so a tool that does not need it is not made to accept it.
func (r *Root) SetMaxResponseBytes(n int) {
	if n > 0 {
		r.maxResponseBytes = n
	}
}

// MaxResponseBytes is the ceiling a tool must size its own reply against.
// Exceeding it reaches main.go's whole-response backstop, which reports an
// fsMCP bug — the wrong answer for a caller who simply asked for too much.
func (r *Root) MaxResponseBytes() int { return r.maxResponseBytes }

// Close releases the underlying root handle.
func (r *Root) Close() error { return r.inner.Close() }

// Lstat reports on name without following a final-component symlink, so a
// symlink is reported as one rather than as whatever it points to.
func (r *Root) Lstat(name string) (fs.FileInfo, error) { return r.inner.Lstat(name) }

// Open opens name for reading.
func (r *Root) Open(name string) (fs.File, error) { return r.inner.Open(name) }

// Stat follows a final-component symlink; Lstat does not.
func (r *Root) Stat(name string) (fs.FileInfo, error) { return r.inner.Stat(name) }

func (r *Root) OpenFile(name string, flag int, perm fs.FileMode) (*os.File, error) {
	return r.inner.OpenFile(name, flag, perm)
}
func (r *Root) Create(name string) (*os.File, error)      { return r.inner.Create(name) }
func (r *Root) ReadFile(name string) ([]byte, error)      { return r.inner.ReadFile(name) }
func (r *Root) Mkdir(name string, perm fs.FileMode) error { return r.inner.Mkdir(name, perm) }
func (r *Root) MkdirAll(name string, perm fs.FileMode) error {
	return r.inner.MkdirAll(name, perm)
}
func (r *Root) Rename(from, to string) error           { return r.inner.Rename(from, to) }
func (r *Root) Remove(name string) error               { return r.inner.Remove(name) }
func (r *Root) RemoveAll(name string) error            { return r.inner.RemoveAll(name) }
func (r *Root) Chmod(name string, m fs.FileMode) error { return r.inner.Chmod(name, m) }
func (r *Root) ReadDir(name string) ([]fs.DirEntry, error) {
	f, err := r.inner.Open(name)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return f.ReadDir(-1)
}

// HostPath is the root's own path on disk. It exists for the one caller that
// legitimately needs it — spawning ripgrep with the root as its working
// directory — and must never reach a result.
func (r *Root) HostPath() string { return r.inner.Name() }

// NormalizePath converts a caller-supplied path into the canonical relative
// form used everywhere else: a single leading '/' is stripped, "" and "."
// both mean the root, and a leading "./" is peeled off. It deliberately does
// not resolve ".." — a lexical collapse here could disagree with the
// symlink-aware, component-by-component resolution os.Root performs with
// openat, which is the actual containment boundary. A NUL byte is refused
// up front since it cannot be part of any real path.
func NormalizePath(p string) (string, error) {
	if strings.IndexByte(p, 0) >= 0 {
		return "", ErrInvalidPath
	}
	p = strings.TrimPrefix(p, "/")
	for strings.HasPrefix(p, "./") {
		p = p[2:]
	}
	if p == "" || p == "." {
		return ".", nil
	}
	return p, nil
}

// MapError turns a Go error into a taxonomy code and a message this
// function writes itself. Never inspect err.Error() at the call site and
// put it in a result — an *fs.PathError from os.Root embeds the path
// exactly as passed in (never the root's own host path), but the rule here
// is not to take that chance: every message returned is static.
func MapError(err error) (proto.ErrorCode, string) {
	switch {
	case err == nil:
		return "", ""
	case errors.Is(err, ErrInvalidPath):
		return proto.ErrInvalidArgument, "path is not a valid path"
	case isPathEscape(err):
		// os.Root refuses an absolute symlink even when its target is inside
		// the root, so "outside the root" is not always literally true here.
		// The message covers both cases rather than asserting the wrong one.
		return proto.ErrOutsideRoot, "path is not reachable within the root — it either leaves the root, " +
			"or traverses an absolute symlink, which is refused even when the target is inside"
	case errors.Is(err, fs.ErrNotExist):
		return proto.ErrNotFound, "no such file or directory"
	case errors.Is(err, fs.ErrExist):
		return proto.ErrExists, "already exists"
	case errors.Is(err, fs.ErrPermission):
		return proto.ErrIOError, "permission denied"
	case isNotADirectory(err):
		return proto.ErrNotADir, "not a directory"
	default:
		return proto.ErrIOError, "i/o error"
	}
}

// Fail turns an error into a tool result, reporting the caller's original
// path spelling. When the caller wrote an absolute path and nothing was
// found, it says how that path was read: an agent told only "not found"
// concludes the host file is absent, rather than that it is addressing a
// different namespace, and an agent that cannot see it is confined behaves
// worse than one that can.
func Fail(err error, origPath string) *proto.CallToolResult {
	code, msg := MapError(err)
	if code == proto.ErrNotFound && strings.HasPrefix(origPath, "/") {
		norm, nerr := NormalizePath(origPath)
		if nerr == nil {
			msg += "; paths are relative to the root, so " + strconv.Quote(origPath) +
				" was read as " + strconv.Quote(norm)
		}
	}
	return proto.NewErrorResult(code, msg, origPath)
}

// isPathEscape recognises os.Root's own refusal of a path that resolves
// outside the root. The standard library does not export a sentinel for
// this, so it matches the documented, stable "path escapes from parent"
// wrapped error rather than any host-path-bearing detail.
func isPathEscape(err error) bool {
	var pe *fs.PathError
	if !errors.As(err, &pe) {
		return false
	}
	return strings.Contains(pe.Err.Error(), "path escapes from parent")
}

// isNotADirectory recognises a path component that exists but is not a
// directory (e.g. "file.txt/x").
func isNotADirectory(err error) bool {
	var pe *fs.PathError
	if !errors.As(err, &pe) {
		return false
	}
	return strings.Contains(pe.Err.Error(), "not a directory")
}
