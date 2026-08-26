package fsapi

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path"
	"regexp"
	"syscall"

	"fsmcp/internal/proto"
)

// errNotRegularFile marks a replace target that exists but is not a regular
// file (a directory or a symlink) — fs_write and fs_replace only ever
// create or replace regular files.
var errNotRegularFile = errors.New("not a regular file")

// errAttrsUnpreservable marks a replace that was refused because the
// target's mode, extended attributes or ACL could not be carried onto the
// replacement. AtomicReplace never proceeds past this without them.
var errAttrsUnpreservable = errors.New("attributes could not be preserved")

// errTargetUndeletable marks a replace refused because the target's ACL denies
// delete. Such a file can still be modified in place — the ACE protects the
// inode, not the bytes — but fsMCP commits through a rename, which it forbids.
var errTargetUndeletable = errors.New("target cannot be replaced")

// errTargetFlagged marks a replace refused because the target carries a BSD
// file flag that forbids being replaced. Kept distinct from
// errTargetUndeletable even though rename(2) reports both as EPERM: the
// remedies are different commands, and a caller told to remove an ACL entry on
// a file that has no ACL at all is being sent after something that is not there.
var errTargetFlagged = errors.New("target is protected by a file flag")

// BSD file flags that make rename(2) refuse to replace a file. Package syscall
// does not export them on darwin and fsMCP takes no module dependency, so the
// four values from <sys/stat.h> are named here. Verified against real files:
// chflags uchg sets 0x2 and chflags uappnd sets 0x4, and both refuse the
// rename — so append-only belongs here beside immutable, not just the latter.
const (
	flagUserImmutable   = 0x00000002 // UF_IMMUTABLE
	flagUserAppend      = 0x00000004 // UF_APPEND
	flagSystemImmutable = 0x00020000 // SF_IMMUTABLE
	flagSystemAppend    = 0x00040000 // SF_APPEND

	flagsForbiddingReplace = flagUserImmutable | flagUserAppend |
		flagSystemImmutable | flagSystemAppend
)

// hasReplaceForbiddingFlag reports whether name carries one of those flags. It
// is a diagnostic, not a gate: the rename has already failed by the time this
// runs, and all it decides is which cause the refusal names.
func hasReplaceForbiddingFlag(root *Root, name string) bool {
	fi, err := root.Lstat(name)
	if err != nil {
		return false
	}
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return false
	}
	return st.Flags&flagsForbiddingReplace != 0
}

// AtomicReplace commits data through a temp file in targetPath's own
// directory, then renames it over targetPath.
//
// Replacing an existing regular file carries its mode, xattrs and ACL onto
// the replacement, minus any set-id or sticky bit. If those cannot be
// preserved the write is refused and targetPath is left untouched — dropping
// them silently is the failure this exists to prevent.
func AtomicReplace(root *Root, targetPath string, data []byte) error {
	dir := path.Dir(targetPath)

	fi, statErr := root.Lstat(targetPath)
	exists := statErr == nil
	if statErr != nil && !errors.Is(statErr, fs.ErrNotExist) {
		return statErr
	}
	if exists && !fi.Mode().IsRegular() {
		return errNotRegularFile
	}

	tmpPath, err := reserveTempName(root, dir, !exists)
	if err != nil {
		return err
	}
	committed := false
	defer func() {
		if !committed {
			discardTemp(root, tmpPath)
		}
	}()

	if exists {
		if err := preserveAttributes(root, targetPath, tmpPath, fi.Mode().Perm()); err != nil {
			return err
		}
		if err := overwriteTempContent(root, tmpPath, data); err != nil {
			return err
		}
	} else {
		if err := writeNewTempContent(root, tmpPath, data); err != nil {
			return err
		}
	}

	// A "deny delete" ACE and an immutable/append-only file flag both block
	// rename(2), so a file carrying either cannot be replaced. Each exists
	// precisely to protect the inode from being replaced, so clearing one to
	// get the write through would defeat the protection it is enforcing.
	// Refuse — and distinguish them, because rename reports both as EPERM
	// while the two are undone by different commands.
	if err := root.Rename(tmpPath, targetPath); err != nil {
		if exists && errors.Is(err, fs.ErrPermission) {
			if hasReplaceForbiddingFlag(root, targetPath) {
				return errTargetFlagged
			}
			return errTargetUndeletable
		}
		return err
	}
	committed = true
	return nil
}

// discardTemp removes an uncommitted temp file. preserveAttributes may have
// copied the target's ACL onto it, and a "deny delete" entry among those makes
// the temp file undeletable — so a plain Remove would strand fsMCP's own
// artifact in the caller's directory. Clearing the ACL here strips a copy
// fsMCP itself made onto a file fsMCP itself created; it never touches the
// target's own.
func discardTemp(root *Root, tmpPath string) {
	if err := root.Remove(tmpPath); err == nil {
		return
	}
	exec.Command("/bin/chmod", "-N", root.HostPath()+"/"+tmpPath).Run()
	root.Remove(tmpPath)
}

// reserveTempName picks an unused name in dir. When creating is true (no
// existing target to seed from), it also creates the file, atomically
// claiming the name via O_EXCL. When false, preserveAttributes is about to
// create the file itself (via cp), so this only picks a name that Lstat
// currently reports as absent.
func reserveTempName(root *Root, dir string, creating bool) (string, error) {
	for attempt := 0; attempt < 8; attempt++ {
		name, err := randomTempName()
		if err != nil {
			return "", err
		}
		tmpPath := path.Join(dir, name)

		if creating {
			f, err := root.OpenFile(tmpPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o666)
			if err != nil {
				if errors.Is(err, fs.ErrExist) {
					continue
				}
				return "", err
			}
			f.Close()
			return tmpPath, nil
		}

		if _, err := root.Lstat(tmpPath); err == nil {
			continue
		} else if !errors.Is(err, fs.ErrNotExist) {
			return "", err
		}
		return tmpPath, nil
	}
	return "", fmt.Errorf("could not find an unused temp name in %q", dir)
}

func randomTempName() (string, error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return ".fsmcp-tmp-" + hex.EncodeToString(buf), nil
}

// writeNewTempContent writes data into a freshly created (O_EXCL) temp
// file with no prior content or attributes to worry about.
func writeNewTempContent(root *Root, tmpPath string, data []byte) error {
	f, err := root.OpenFile(tmpPath, os.O_WRONLY, 0o666)
	if err != nil {
		return err
	}
	return writeAndClose(f, data)
}

// overwriteTempContent replaces the content of a temp file that
// preserveAttributes has already seeded with the target's old content,
// mode, xattrs and ACL. Truncating and rewriting leaves all of those
// alone — only the bytes change.
func overwriteTempContent(root *Root, tmpPath string, data []byte) error {
	f, err := root.OpenFile(tmpPath, os.O_WRONLY|os.O_TRUNC, 0)
	if err != nil {
		return err
	}
	return writeAndClose(f, data)
}

func writeAndClose(f *os.File, data []byte) error {
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

// preserveAttributes seeds tmpPath with targetPath's content, mode,
// extended attributes and ACL by shelling out to /bin/cp -pN, then
// re-asserts the exact permission bits with chmod(2).
//
// Go's standard library has no xattr or ACL binding on darwin — the
// syscall package exports no Getxattr/Setxattr/Listxattr for this GOOS,
// and there is no ACL API at all — and this package may not take on a new
// module dependency. copyfile(3), which /bin/cp -p wraps, is macOS's own
// supported mechanism for exactly this, so spawning it is the tool for the
// job rather than a workaround. cp is invoked by absolute path with a
// literal, fully-owned argv: no PATH resolution, no shell.
//
// This is deliberate: cp -p preserves a setuid/setgid bit when the copy is
// made by the file's own owner, which it always is here — but a replaced
// file must never come out setuid (see AtomicReplace's doc). The chmod(2)
// call after cp reasserts exactly perm (0-0777), which drops any set-id or
// sticky bit cp copied and cannot itself be eaten by umask, closing that
// gap without touching the xattrs or ACL chmod(2) never reads.
//
// This is deliberate too: -N suppresses copying BSD file flags, and removing
// it strands fsMCP's own artifacts. Copying uchg onto the temp file makes that
// temp undeletable by the process that just created it, so discardTemp cannot
// clean up and a .fsmcp-tmp-* file is left in the caller's directory on every
// failure path. The cost is that flags are not carried across a replace, which
// DESIGN.md states as a non-guarantee rather than leaving it to be discovered.
func preserveAttributes(root *Root, targetPath, tmpPath string, perm fs.FileMode) error {
	// This is deliberate: these two strings are built by concatenation,
	// not path/filepath.Join. Join would lexically collapse a ".." in
	// targetPath before the OS ever saw it — exactly the shortcut
	// NormalizePath's own doc comment refuses to take, because a lexical
	// collapse can disagree with the symlink-aware walk that already
	// validated this path through root.Lstat above. A raw concatenation
	// hands the OS the identical component sequence os.Root resolved, so
	// cp's own open() walks it the same way and lands on the same file.
	hostTarget := root.HostPath() + "/" + targetPath
	hostTmp := root.HostPath() + "/" + tmpPath

	cmd := exec.Command("/bin/cp", "-pN", hostTarget, hostTmp)
	if err := cmd.Run(); err != nil {
		return errAttrsUnpreservable
	}

	if err := root.Chmod(tmpPath, perm); err != nil {
		return errAttrsUnpreservable
	}
	return nil
}

// --- if_sha256 precondition, shared by fs_write and fs_replace ---

// preconditionKind classifies a parsed if_sha256 argument. There is no
// default kind: an argument that does not fit one of the three legal
// shapes is not classified at all — see parsePrecondition.
type preconditionKind int

const (
	// preconditionAbsent means the "if_sha256" key was not present in the
	// arguments object at all. This is a schema violation, not a value —
	// there is no default, so a caller cannot blind-write by omission.
	preconditionAbsent preconditionKind = iota
	// preconditionCreate means if_sha256 was the JSON literal null: the
	// file must not currently exist.
	preconditionCreate
	// preconditionHash means if_sha256 was a 64-lowercase-hex string: the
	// file must currently hash to it.
	preconditionHash
)

var hexSHA256Pattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

// parsePrecondition classifies raw, the "if_sha256" field of a fs_write or
// fs_replace call, captured as json.RawMessage precisely so "absent" and
// "explicit null" stay distinguishable — a plain string field would
// collapse them, and that distinction is the whole guarantee DESIGN.md
// describes: an agent cannot blind-write by omitting the field.
//
// ok is false when raw is present but fits none of the three legal
// shapes (wrong JSON type, or a string that is not 64 lowercase hex
// characters); the caller should refuse with invalid_argument.
func parsePrecondition(raw json.RawMessage) (kind preconditionKind, hash string, ok bool) {
	if len(raw) == 0 {
		return preconditionAbsent, "", true
	}
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return preconditionCreate, "", true
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return 0, "", false
	}
	if !hexSHA256Pattern.MatchString(s) {
		return 0, "", false
	}
	return preconditionHash, s, true
}

// checkPrecondition resolves p's current content against a parsed
// if_sha256 precondition (kind, hash — meaningful only when kind is
// preconditionHash). It returns the file's current bytes when the
// precondition is satisfied (nil when the file does not exist), or a
// ready-made failure result when it is not. Every legal shape is checked
// in full before either return value is used for a write, so a rejected
// precondition never leaves a partial effect.
func checkPrecondition(root *Root, p string, kind preconditionKind, hash string) (current []byte, failure *proto.CallToolResult) {
	fi, err := root.Lstat(p)
	switch {
	case err == nil:
		if !fi.Mode().IsRegular() {
			return nil, proto.NewErrorResult(proto.ErrNotAFile, "not a regular file", p)
		}
		data, rerr := root.ReadFile(p)
		if rerr != nil {
			return nil, Fail(rerr, p)
		}
		if kind == preconditionCreate {
			return nil, proto.NewErrorResult(proto.ErrExists, "file already exists", p)
		}
		sum := sha256.Sum256(data)
		if hex.EncodeToString(sum[:]) != hash {
			return nil, proto.NewErrorResult(proto.ErrPreconditionFailed, "if_sha256 does not match the file's current contents", p)
		}
		return data, nil

	case errors.Is(err, fs.ErrNotExist):
		if kind == preconditionHash {
			return nil, proto.NewErrorResult(proto.ErrNotFound, "no such file or directory", p)
		}
		return nil, nil

	default:
		return nil, Fail(err, p)
	}
}
