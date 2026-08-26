import * as path from 'path';
import { MCPCallResult, MCPContent, LabelEntry, scopeViolationResult } from './types';
import { NO_ALLOWED_DIRS_MESSAGE } from './security';

/**
 * Issue #7: the client never sees a host path, in either direction. It
 * addresses files in a virtual space rooted at its grant (`/d0/notes/a.txt`)
 * and this module translates at the boundary -- inbound before
 * `security.ts` ever sees a path, outbound after a tool handler has already
 * produced its result.
 *
 * The one rule everything here answers to: **this is a layer on top of
 * `security.ts`, never a replacement for it.** Inbound translation only ever
 * turns a virtual path into the exact host-path string `validatePath` /
 * `validatePathNoFollowFinal` would have received before this issue existed
 * -- literal string concatenation, not `path.join` (see `virtualToHost`'s
 * doc for why `path.join`'s own lexical `..` normalisation would quietly
 * undo `canonicalizePath`'s kernel-style walk before it ever runs). Every
 * symlink, `..`, dangling-link and canonicalisation argument in security.ts
 * still runs, unmodified, on that host path, and still decides. Nothing in
 * this file resolves a symlink, canonicalizes a path, or makes a
 * scope decision on its own merits -- it only renames strings that
 * `security.ts` has already judged, or is about to.
 */

// LabelEntry (one allowed directory's label and the host path it stands for)
// lives in types.ts, so ToolContext can reference it there without a
// types.ts <-> vpath.ts import cycle. Built fresh per call from
// `ToolContext.allowedDirs` (the *effective*, already narrowed scope for
// this call) -- there is no persistent label registry across calls, because
// fsmcp keeps no state across calls at all (see CLAUDE.md's C7/TOCTOU
// discussion for why that statelessness is load-bearing elsewhere too). A
// caller's labels are therefore stable for as long as the operator's
// configuration (CLI flags, or relay's per-token `allowed_dirs`) is stable,
// and change only when that configuration does -- documented in the README
// as the tradeoff of positional labelling.

/**
 * An `allowed_dirs` entry may be written `label=/abs/path` to pin an
 * explicit, stable label instead of taking whatever position it lands on.
 * The label half is anything up to the first `=`, and the path half must
 * itself be absolute -- `[^=/]+` deliberately excludes `/`, so a raw
 * absolute path (which always starts with `/`) can never itself match this
 * pattern and be misread as "label `/Users`, path `admin/...`". A host path
 * that legitimately contains `=` in one of its own components (rare, but
 * valid on every OS fsmcp runs on) is indistinguishable from this syntax by
 * construction; the issue that introduced this convention accepts that
 * tradeoff explicitly rather than inventing an escaping rule for a
 * vanishingly rare directory name.
 */
const LABELED_ENTRY_RE = /^([^=/]+)=(\/.*)$/;

export interface StrippedDirs {
  /** Bare, absolute host paths -- exactly what narrowAllowedDirs/validatePath expect. */
  hostPaths: string[];
  /** Explicit label, keyed by the bare host path it was written against. */
  labelByHostPath: Map<string, string>;
}

/**
 * Split a raw `allowed_dirs` entry (a CLI `--allowed-dir` value, or one
 * element of `_meta.allowed_dirs`) into its bare host path and, if present,
 * its explicit label.
 *
 * This must run BEFORE any of these strings reach `narrowAllowedDirs` or
 * `validatePath`: both call `path.isAbsolute()` on every entry, and
 * `"label=/abs/path"` is not absolute (it starts with a letter, not `/`).
 * Left unstripped, `canonicalizePath` would fall back to
 * `path.resolve(inputPath)` for that non-absolute string -- resolving it
 * against fsmcp's own CWD, not against anything the operator meant -- so an
 * explicit label would not just fail to register, it would silently corrupt
 * the containment check for that entry.
 */
export function stripLabels(raw: string[]): StrippedDirs {
  const hostPaths: string[] = [];
  const labelByHostPath = new Map<string, string>();
  for (const entry of raw) {
    const m = LABELED_ENTRY_RE.exec(entry);
    if (m) {
      const [, label, hostPath] = m;
      hostPaths.push(hostPath);
      labelByHostPath.set(hostPath, label);
    } else {
      hostPaths.push(entry);
    }
  }
  return { hostPaths, labelByHostPath };
}

/** Strip exactly one trailing separator, so a hostDir is never stored two ways. */
function stripTrailingSep(p: string): string {
  return p.length > 1 && p.endsWith(path.sep) ? p.slice(0, -1) : p;
}

/**
 * Assign this call's labels: explicit `label=` wins (looked up by the exact
 * bare host-path string it was written against, from either CLI or `_meta`
 * -- callers merge both maps before calling this), otherwise `d<N>` by
 * position **in the effective, already-narrowed scope for this call**
 * (`ToolContext.allowedDirs`), not in whatever order the operator originally
 * listed CLI flags or `_meta` entries in. That is the only ordering fsmcp
 * can give a stable meaning to per call: `_meta`-mediated narrowing (C1) can
 * change which entries survive, and in what order, from one call to the
 * next only if the operator's own configuration changes -- and the README
 * says plainly that reordering `allowed_dirs` renames a client's paths, so
 * this is a documented tradeoff, not an oversight.
 *
 * Always `/<label>/...`, including for a single root: a bare `/` for one
 * root would mean the day a second directory is added, every path a client
 * has already learned or stored silently changes shape. That is worse than
 * the four extra characters (issue #7).
 */
export function assignLabels(allowedDirs: string[], labelByHostPath: Map<string, string>): LabelEntry[] {
  return allowedDirs.map((hostDir, i) => {
    const bare = stripTrailingSep(hostDir);
    return { label: labelByHostPath.get(hostDir) ?? `d${i}`, hostDir: bare };
  });
}

/**
 * Inbound: `/<label>/rest...` -> `<hostDir><rest>`, by literal string
 * concatenation.
 *
 * Deliberately NOT `path.join(hostDir, rest)`: `path.join` normalises `..`
 * lexically before returning, which is exactly the shortcut
 * `canonicalizePath`'s own doc comment warns against -- "`..` must be
 * applied to the resolved path, never collapsed lexically first". A virtual
 * path of `/d0/sub/link/../../x`, where `sub/link` is a symlink pointing
 * outside the allowed dir, MUST reach `validatePath` as the literal string
 * `<hostDir>/sub/link/../../x` so `canonicalizePath`'s component-by-component
 * walk resolves the symlink first and applies `..` to *that* -- pre-joining
 * here would collapse the `..` against the lexical string instead and hand
 * `validatePath` a path that reads as staying inside the sandbox when the
 * kernel would not. This function's entire job is to reproduce, byte for
 * byte, the host-path string every tool handler already validated before
 * this issue existed; anything cleverer than concatenation risks being a
 * second, weaker path checker standing in front of the real one.
 *
 * Returns null when `virtualPath` is not absolute or names no known label --
 * the caller (`decodeInboundPath`) turns that into a refusal. Returning null
 * here rather than refusing directly keeps this function a pure translator,
 * matching `validatePath`'s own `string | null` shape.
 */
export function virtualToHost(virtualPath: string, labels: LabelEntry[]): string | null {
  if (!virtualPath.startsWith('/')) return null;
  const secondSlash = virtualPath.indexOf('/', 1);
  const label = secondSlash === -1 ? virtualPath.slice(1) : virtualPath.slice(1, secondSlash);
  if (label === '') return null;
  const entry = labels.find((l) => l.label === label);
  if (!entry) return null;
  if (secondSlash === -1) return entry.hostDir; // "/d0" exactly -> the root itself
  const rest = virtualPath.slice(secondSlash); // includes its own leading "/"
  // hostDir === "/" (the documented `--allowed-dir /` opt-out) is the one
  // case `hostDir + rest` would double the separator ("/" + "/var/x"): rest
  // already supplies the single "/" that belongs between the root and the
  // rest of the path, so it stands alone rather than getting a second one
  // prepended.
  return entry.hostDir === path.sep ? rest : entry.hostDir + rest;
}

/**
 * The refusal a tool handler returns for an inbound path argument, wrapping
 * `virtualToHost`.
 *
 * Two refusals, both `scopeViolationResult` -- not `errorResult` -- because
 * both are exactly "this call cannot address anything outside its scope",
 * the same family `isScopeViolationMessage` (security.ts) already
 * recognises for "no allowed directories" and "outside allowed directories":
 *
 *  - an empty scope (`labels.length === 0`) reuses `NO_ALLOWED_DIRS_MESSAGE`
 *    verbatim, so every existing "no allowed directories are configured"
 *    assertion keeps meaning exactly what it always meant -- there is
 *    nothing to be a valid label against in the first place, the same
 *    fail-closed case `validatePath` itself already refuses.
 *  - a non-empty scope that the path does not address in valid `/<label>/`
 *    form. This is deliberately NOT the same message `validatePath` gives
 *    for "outside allowed directories": that message describes a host path
 *    which resolved somewhere out of scope, and this path was never
 *    resolved at all because it was never accepted as an address. Collapsing
 *    the two would blur "you named something outside your grant" (a host
 *    path escaped the check) and "you did not name anything in fsmcp's
 *    address space" (a host path was never a legal address to begin with) --
 *    and the second is exactly the probe oracle issue #7 exists to close, so
 *    it gets its own words. It still counts as a scope violation for relay's
 *    audit: a caller that cannot spell an address inside its grant is, by
 *    construction, trying to name something outside it.
 */
export function decodeInboundPath(virtualPath: string, labels: LabelEntry[]): string | MCPCallResult {
  if (labels.length === 0) {
    return scopeViolationResult(NO_ALLOWED_DIRS_MESSAGE);
  }
  const host = virtualToHost(virtualPath, labels);
  if (host !== null) return host;
  const known = labels.map((l) => `/${l.label}`).join(', ');
  return scopeViolationResult(
    `path ${virtualPath} is not a valid address: every path must begin with one of this call's ` +
      `granted labels (${known}), not an absolute host path -- see tools/list or a prior result ` +
      `for the labels currently in scope`
  );
}

/**
 * Outbound, single path: `<hostDir><rest>` -> `/<label><rest>`, sorted
 * longest-`hostDir`-first so a nested allowed dir (e.g. both `/a` and
 * `/a/b` granted separately, with distinct labels) maps to its most specific
 * label rather than the shorter, less specific one matching first.
 *
 * Returns null when `hostPath` sits under none of `labels`' directories.
 * Every real call site re-validates with `security.ts`'s own `validatePath`
 * before it ever reaches here (this function makes no scope decision of its
 * own), so null should be unreachable in practice; callers still redact
 * rather than emit when it happens, per issue #7's outbound rule -- "if a
 * host path cannot be mapped back, do not emit it" -- treating the
 * unreachable case as the bug it would be rather than assuming it away.
 */
export function hostToVirtual(hostPath: string, labels: LabelEntry[]): string | null {
  const sorted = [...labels].sort((a, b) => b.hostDir.length - a.hostDir.length);
  for (const { label, hostDir } of sorted) {
    if (hostPath === hostDir) return `/${label}`;
    const prefix = hostDir.endsWith(path.sep) ? hostDir : hostDir + path.sep;
    if (hostPath.startsWith(prefix)) {
      // Slicing off `prefix` (not just `hostDir`) consumes the separator
      // along with the directory, so `rest` never has one of its own --
      // load-bearing for hostDir === "/" (the `--allowed-dir /` opt-out),
      // where `hostDir.length` alone would slice off nothing and leave the
      // path's own leading "/" glued directly onto the label with no
      // separator between them at all (`/d0var/x`, not `/d0/var/x`).
      const rest = hostPath.slice(prefix.length);
      return `/${label}/${rest}`;
    }
  }
  return null;
}

/** What issue #7 calls "emit a redaction": a placeholder that names the shape of the bug without naming the path. */
export const REDACTED_PATH = '[fsmcp: path outside the granted directories -- redacted]';

/** `hostToVirtual`, but the caller-facing form: never returns null, redacts instead. */
export function hostToVirtualOrRedact(hostPath: string, labels: LabelEntry[]): string {
  return hostToVirtual(hostPath, labels) ?? REDACTED_PATH;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The outbound backstop for every tool result: replace every occurrence of a
 * known host directory with its label, wherever it appears in the text --
 * this is what closes "the part that will actually be missed" (issue #7):
 * raw syscall error text. `fs.rmSync`/`fs.renameSync`/etc. embed the exact
 * host path fsmcp itself passed to the syscall in their own `err.message`
 * (`ENOTEMPTY: directory not empty, rmdir '/Users/.../root/notes'`), and
 * nothing upstream of that message ever gets a chance to build a virtual
 * form instead -- Node writes it three stack frames inside a C++ binding.
 * Post-processing every result's text against the known host directories is
 * the only place that catches it, and it is applied here, once, in
 * `ToolRegistry.call` (registry.ts), rather than trusted to each handler
 * that happens to build an error string.
 *
 * A path-boundary lookahead (`/`, newline, or end of string) stops
 * `/allowed/project` from also matching inside an unrelated
 * `/allowed/project-old` -- a bare substring replace would corrupt that
 * sibling's name instead of leaving it alone. Longest-hostDir-first for the
 * same nesting reason `hostToVirtual` sorts: a shorter allowed dir must not
 * consume the prefix of a longer, more specific one that also matches here.
 *
 * Deliberately narrow: this only ever removes strings fsmcp itself
 * configured as allowed directories. It does not attempt to recognise "any
 * absolute-looking path" in free text, because tool output legitimately
 * contains caller-supplied and file-content text that can look like a path
 * without being one of fsmcp's -- `fs_grep`'s own `invalid regex: <pattern>`
 * message echoes the caller's `pattern` verbatim, and a pattern of
 * `/etc/passwd` is not a host-path leak, it is fsmcp quoting the caller back
 * to themselves. A heuristic broad enough to catch an unrelated leak would
 * also redact that quote, trading a real (but here unreachable, see
 * `hostToVirtualOrRedact`) hazard for a routine false positive on ordinary
 * error text.
 */
export function rewriteHostPaths(text: string, labels: LabelEntry[]): string {
  if (labels.length === 0) return text;
  const sorted = [...labels].sort((a, b) => b.hostDir.length - a.hostDir.length);
  let out = text;
  for (const { label, hostDir } of sorted) {
    const re = new RegExp(`${escapeRegExp(hostDir)}(?=[/\\n]|$)`, 'g');
    out = out.replace(re, `/${label}`);
  }
  return out;
}

/**
 * Applied to every tool result, success or error, in `ToolRegistry.call` --
 * the one place every handler's output (and registry.call's own
 * catch-and-`errorResult` backstop for a thrown exception) passes through
 * before it reaches the wire. See `rewriteHostPaths` for what this does and
 * does not catch.
 */
export function translateResultToVirtual(result: MCPCallResult, labels: LabelEntry[]): MCPCallResult {
  if (labels.length === 0) return result;
  const content: MCPContent[] = result.content.map((item) => ({
    ...item,
    text: rewriteHostPaths(item.text, labels),
  }));
  return { ...result, content };
}
