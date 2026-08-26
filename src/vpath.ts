import * as path from 'path';
import { MCPCallResult, MCPContent, LabelEntry, errorResult, scopeViolationResult } from './types';
import {
  NO_ALLOWED_DIRS_MESSAGE,
  canonicalizePath,
  checkPath,
  checkPathNoFollowFinal,
  refuseAllowedDirRoot,
  refuseAllowedDirRootWrite,
} from './security';

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
 * this file implements its own resolution rule or makes a scope decision on
 * its own merits -- it only renames strings that `security.ts` has already
 * judged, or is about to.
 *
 * There is exactly one place this file needs to know what a path resolves
 * to (`assignLabels`, recording each granted directory's canonical spelling
 * for outbound translation -- issue #21), and it gets that answer by
 * calling `security.ts`'s own `canonicalizePath`, the same function
 * `isWithinAnyDir` uses to decide containment. That is deliberate and it is
 * the opposite of a second path checker: the failure this fixes was the
 * outbound map disagreeing with `security.ts` about which strings name the
 * same directory, and the fix is to ask `security.ts` rather than to grow a
 * resolution rule of this file's own.
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
 *
 * Returns an `MCPCallResult` refusal, not `LabelEntry[]`, when two DIFFERENT
 * directories in this call's effective scope would land on the same label
 * -- both from two explicit `label=`s, or from an explicit `label=` that
 * happens to match another entry's auto-assigned `d<N>` (reachable from a
 * shape like `--allowed-dir d1=/x --allowed-dir /y --allowed-dir /z`, where
 * `/z` is position 2 but `/y` is position 1 and so would be `d1` -- a
 * collision no operator would predict just by reading their own flags in
 * order). `virtualToHost` resolves a label with `Array.prototype.find`,
 * which silently returns the FIRST match, so a collision left unrefused
 * does not error -- it quietly makes the second directory unaddressable and,
 * worse, makes `fs_glob`/`fs_find`/`fs_grep` report the identical virtual
 * path for two genuinely different files, with `fs_read` of that path
 * always resolving to the first-registered directory: a caller believing it
 * addressed the second gets the first one's bytes instead, and a write
 * clobbers the first while the caller may believe it is addressing the
 * second. This codebase already refuses exactly this SHAPE of ambiguity
 * rather than picking a winner -- `fs_edit` refuses a non-unique
 * `old_string` instead of replacing the first match, `validatePath` refuses
 * an empty scope instead of reading it as "everything" -- and an
 * unspecified collision policy is the argument for refusing here too, not
 * for leaving the ambiguity to resolve itself silently to whichever entry
 * happens to be enumerated first.
 *
 * The refusal the CLIENT reads names only the label. The two colliding
 * directories go to stderr instead, where the operator reads them.
 *
 * This used to name both directories to the client, on the reasoning that
 * `allowedDirs` only ever holds an operator's own CLI directories or
 * `_meta` entries the caller itself supplied, so the message could disclose
 * nothing the reader did not already have. That reasoning holds for the
 * standalone CLI case and fails for the one that matters. Under relay,
 * `--allowed-dir` is not passed at all: the whole scope arrives through
 * `_meta`, which **relay** populates from context an operator configured,
 * and which the client cannot set (relay builds it from stored context --
 * `relay/router.go:533` -- and never forwards a client's). So in the
 * deployment this server exists for, the directories in a collision are the
 * operator's host paths and the reader is the one party issue #7 exists to
 * keep them from. A misconfiguration is a poor reason to hand over the
 * thing every other surface here is careful not to.
 *
 * The label alone is also the more useful half for each reader. A client
 * can do nothing with the host paths; it cannot fix the configuration, and
 * every call fails until someone does. An operator needs both paths, and
 * has stderr.
 */
export function assignLabels(
  allowedDirs: string[],
  labelByHostPath: Map<string, string>
): LabelEntry[] | MCPCallResult {
  const hostDirByLabel = new Map<string, string>();
  const entries: LabelEntry[] = [];
  for (let i = 0; i < allowedDirs.length; i++) {
    const bare = stripTrailingSep(allowedDirs[i]);
    const label = labelByHostPath.get(allowedDirs[i]) ?? `d${i}`;
    const claimedBy = hostDirByLabel.get(label);
    // The same directory landing on the same label twice (a literal
    // duplicate --allowed-dir entry) is redundant, not ambiguous -- both
    // instances already mean the same host path, so there is nothing for a
    // client to confuse. Only a DIFFERENT directory claiming an
    // already-used label is the failure this refuses.
    if (claimedBy !== undefined && claimedBy !== bare) {
      // The operator's copy, with the detail needed to fix it. stderr is not
      // the protocol stream (stdout is), so this cannot corrupt a response,
      // and it is where a stdio MCP's host collects a child's diagnostics.
      process.stderr.write(
        `fsmcp: label "${label}" is claimed by two different allowed directories: ` +
          `${claimedBy} and ${bare}. Every call is refused until each has a distinct label.\n`
      );
      return errorResult(
        `fsmcp: this server's configuration is ambiguous -- the label "${label}" is claimed by two ` +
          `different allowed directories, so an address beginning "/${label}/" does not identify one ` +
          `file. Refusing every call rather than silently resolving it to one of them. An operator ` +
          `must give each directory a distinct label; the details are in this server's stderr.`
      );
    }
    hostDirByLabel.set(label, bare);
    // `realHostDir` is `bare` as security.ts's own resolver sees it (issue
    // #21). Computed once per call here rather than per emitted path,
    // because it is a property of the GRANT, not of any one hit, and
    // because `hostToVirtual` runs once per result line (up to 1000 for
    // fs_glob) where a syscall each would be paid for nothing.
    //
    // `?? bare` for the unresolvable case (a symlink cycle in the grant
    // itself): `canonicalizePath` returning null already means
    // `isWithinAnyDir` skips that directory entirely, so nothing can ever
    // be validated into it and nothing can reach outbound translation
    // wanting it -- falling back to the literal spelling keeps this a total
    // function without inventing an answer that could ever be consulted.
    entries.push({ label, hostDir: bare, realHostDir: canonicalizePath(bare) ?? bare });
  }
  return entries;
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
  // The refusal does NOT echo `virtualPath` back, even though the caller
  // already knows what it sent. Found in review (PR #10): the earlier
  // version of this message included it, and that argument used to pass
  // through the outbound translation pass too -- so a CORRECT host-path
  // guess came back rewritten to its label ("path /d0/a.txt is not a valid
  // address"), while a wrong guess came back byte-for-byte unchanged. That
  // difference is a working oracle: try a candidate host path, read the
  // reply, learn whether it matched a granted directory -- exactly the
  // capability issue #7 exists to remove, just moved from "did fs_read
  // succeed" to "was this refusal's echo rewritten". The fix is not to stop
  // rewriting the echo (still a working, just noisier, oracle: rewritten
  // vs. not is itself the signal) -- it is to stop echoing the caller's
  // input at all. Naming the granted labels is not a comparable leak: they
  // are already handed to the client on every successful call and in every
  // other refusal.
  const known = labels.map((l) => `/${l.label}`).join(', ');
  return scopeViolationResult(
    `path is not a valid address: every path must begin with one of this call's granted labels ` +
      `(${known}), not an absolute host path -- see tools/list or a prior result for the labels ` +
      `currently in scope`
  );
}

/**
 * Outbound, single path: `<grantedDir><rest>` -> `/<label><rest>`, sorted
 * longest-directory-first so a nested allowed dir (e.g. both `/a` and
 * `/a/b` granted separately, with distinct labels) maps to its most specific
 * label rather than the shorter, less specific one matching first.
 *
 * Each label offers TWO spellings of its one directory (issue #21): the
 * literal `hostDir` the operator wrote, and `realHostDir`, the same
 * directory as `canonicalizePath` resolves it. They are the same string
 * unless the grant is reached through a symlink, and when they differ, a
 * tool that produces a path in resolved form -- `fs_glob`, which now hands
 * `globSync` a resolved `cwd` because glob will not descend a symlinked one
 * (issue #21), and anything else that ever resolves before it emits --
 * matched neither the old single prefix nor any other label, and every one
 * of its hits came back as `REDACTED_PATH`. That is the failure this
 * function exists to prevent, arriving as a false alarm instead of as
 * silence, so it has to be fixed here rather than tolerated.
 *
 * **Recognising the second spelling maps no file the first did not already
 * map.** `canonicalizePath` resolves a path prefix-first, so
 * `canonicalizePath(hostDir + rest)` and `canonicalizePath(realHostDir +
 * rest)` are the same path for every `rest`: the two spellings name exactly
 * the same set of files, and the virtual address this returns round-trips
 * through `virtualToHost` back onto that same file either way. In
 * particular, this does NOT widen what can be named out of scope: a `rest`
 * that escapes the grant through an inner symlink (`realHostDir/link-out/x`)
 * escapes identically through the unresolved spelling
 * (`hostDir/link-out/x`), which this function has always matched, and both
 * are stopped where they have always been stopped -- at the `validatePath`
 * every call site runs BEFORE it gets here. This function still makes no
 * scope decision of its own; it decides how to SHOW a path something else
 * already judged.
 *
 * Returns null when `hostPath` sits under none of `labels`' directories in
 * either spelling. Every real call site re-validates with `security.ts`'s
 * own `validatePath` before it ever reaches here, so null should be
 * unreachable in practice; callers still redact rather than emit when it
 * happens, per issue #7's outbound rule -- "if a host path cannot be mapped
 * back, do not emit it" -- treating the unreachable case as the bug it
 * would be rather than assuming it away. Issue #21 is what that redaction
 * would have looked like in the field if `fs_glob` had been fixed on its
 * own: a page of placeholders in place of a page of real filenames, which
 * is a different way of telling a caller nothing, not a fix.
 */
export function hostToVirtual(hostPath: string, labels: LabelEntry[]): string | null {
  // One candidate per (label, spelling). A label whose two spellings are
  // identical -- every grant not reached through a symlink, i.e. almost all
  // of them -- contributes exactly one, so the ordinary case is byte-for-byte
  // the comparison this function has always done.
  const candidates: { label: string; dir: string }[] = [];
  for (const { label, hostDir, realHostDir } of labels) {
    candidates.push({ label, dir: hostDir });
    if (realHostDir !== hostDir) candidates.push({ label, dir: realHostDir });
  }
  // Stable sort (V8 guarantees it), so two equal-length directories keep
  // their `labels` order and this stays a pure refinement of the old
  // longest-first rule rather than a reshuffle of it.
  candidates.sort((a, b) => b.dir.length - a.dir.length);
  for (const { label, dir } of candidates) {
    if (hostPath === dir) return `/${label}`;
    const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
    if (hostPath.startsWith(prefix)) {
      // Slicing off `prefix` (not just `dir`) consumes the separator
      // along with the directory, so `rest` never has one of its own --
      // load-bearing for a granted "/" (the `--allowed-dir /` opt-out),
      // where `dir.length` alone would slice off nothing and leave the
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
 * Replace every occurrence of ONE specific, already-known host path with its
 * virtual form (or a redaction, if it cannot be mapped -- see
 * `hostToVirtualOrRedact`), wherever it appears in `text`.
 *
 * This is deliberately narrow in a way a whole-result rewrite (what this
 * used to be, before PR #10 review found the problem with it) is not: it
 * only ever touches a substring the CALLER of this function already knows
 * is a path, because the caller is the one who decoded it, passed it to a
 * syscall, or built a message that names it. It never scans arbitrary
 * output looking for anything that resembles one of fsmcp's directories.
 * That distinction is why this is safe to use on a message and unsafe to
 * use on file content: `fs_read`'s own bytes, or `fs_grep` content mode's
 * matched line text, are never passed to this function as `hostPath`, so
 * they are never candidates for replacement no matter what they contain --
 * a file whose content happens to be (or contain) the sandbox's own host
 * path comes back byte for byte unchanged, which the old whole-result
 * rewrite did not guarantee (it corrupted exactly that file, confirmed by a
 * write-then-read round trip in review).
 *
 * A path-boundary lookahead is unnecessary here (unlike the old
 * whole-result version): `hostPath` is an exact, complete path string, not
 * a directory prefix that could also match a longer sibling's name, so a
 * plain substring split/join cannot mis-fire the way scanning for a
 * directory prefix across free text could.
 */
export function translatePathIn(text: string, hostPath: string, labels: LabelEntry[]): string {
  if (labels.length === 0 || !text.includes(hostPath)) return text;
  return text.split(hostPath).join(hostToVirtualOrRedact(hostPath, labels));
}

/**
 * `translatePathIn`, applied across every content item of a result, for
 * every host path the caller already knows is embedded in it. The ordinary
 * shape for a tool handler's own success/error message: it already has the
 * decoded host path (or two, for `fs_move`) in scope, and passes it here
 * once, right before returning, rather than threading a second "virtual
 * form of this same variable" through every template string.
 */
export function translateResult(result: MCPCallResult, hostPaths: string[], labels: LabelEntry[]): MCPCallResult {
  if (labels.length === 0 || hostPaths.length === 0) return result;
  const content: MCPContent[] = result.content.map((item) => {
    let text = item.text;
    for (const hostPath of hostPaths) text = translatePathIn(text, hostPath, labels);
    return { ...item, text };
  });
  return { ...result, content };
}

/**
 * `security.ts`'s `checkPath`, wrapped so the refusal it returns (which
 * embeds `filePath` verbatim -- "path <filePath> is outside allowed
 * directories") comes back with that path already in its virtual form.
 * `filePath` here is always the ALREADY-DECODED host path a tool handler is
 * about to check, so this is exactly the same "one known substring" shape
 * `translatePathIn` is built for -- not a second, independent check:
 * `checkPath` (security.ts, untouched) still makes every decision, this
 * only renames the path in the message it hands back.
 */
export function checkPathV(filePath: string, allowedDirs: string[], labels: LabelEntry[]): MCPCallResult | null {
  const result = checkPath(filePath, allowedDirs);
  return result ? translateResult(result, [filePath], labels) : null;
}

/** `checkPathV`, built on `checkPathNoFollowFinal` (C2) for fs_delete -- see checkPathV's doc. */
export function checkPathNoFollowFinalV(
  filePath: string,
  allowedDirs: string[],
  labels: LabelEntry[]
): MCPCallResult | null {
  const result = checkPathNoFollowFinal(filePath, allowedDirs);
  return result ? translateResult(result, [filePath], labels) : null;
}

/**
 * `security.ts`'s `refuseAllowedDirRootWrite` -- the write-side half of the
 * allowed_dir-root rule (issue #24) -- wrapped the same way `checkPathV`
 * wraps `checkPath`: `security.ts` still decides, this only renames the
 * path in the message it hands back. `targetPath` is the already-decoded
 * host path, and the refusal embeds it verbatim, so an alias spelling comes
 * back in the shape the caller sent it (`/d0/notes/..`, not `/d0`) rather
 * than in a normalised form that would quietly disagree with the argument
 * the caller is looking at.
 */
export function refuseAllowedDirRootWriteV(
  targetPath: string,
  allowedDirs: string[],
  action: string,
  labels: LabelEntry[]
): MCPCallResult | null {
  const result = refuseAllowedDirRootWrite(targetPath, allowedDirs, action);
  return result ? translateResult(result, [targetPath], labels) : null;
}

/** `security.ts`'s `refuseAllowedDirRoot`, wrapped the same way `checkPathV` wraps `checkPath`. */
export function refuseAllowedDirRootV(
  targetPath: string,
  allowedDirs: string[],
  action: string,
  labels: LabelEntry[]
): MCPCallResult | null {
  const result = refuseAllowedDirRoot(targetPath, allowedDirs, action);
  return result ? translateResult(result, [targetPath], labels) : null;
}

/**
 * Build the text for a caught exception, translating the offending path(s)
 * if Node's own error object names them structurally.
 *
 * Every `fs.*Sync` error is a `NodeJS.ErrnoException` carrying the syscall's
 * own path as a real property (`.path`, and `.dest` too for a rename) --
 * not just baked into `.message` as unstructured text. That property is the
 * "hook" this issue needed and the old whole-result rewrite made
 * unnecessary-looking: reading it lets the exact offending path be
 * translated and the message rebuilt around it, instead of scanning the
 * finished message for a directory prefix that happens to match. `err.path`
 * is also correct for an error that names a path DEEPER than the one the
 * caller passed in (a recursive delete failing three directories down):
 * `translatePathIn`'s substring match still finds it because a real
 * descendant path is always lexically prefixed by its ancestor, but reading
 * `.path` off the exception is the precise version of that, not a
 * coincidence this happens to rely on.
 *
 * Falls back to the plain message, untranslated, when neither property is
 * present -- a small residual surface (a non-fs exception, or a future
 * Node error shape without them) that `redactLeakedHostPaths` exists to
 * catch as a backstop, not to translate.
 */
export function describeError(err: unknown, labels: LabelEntry[]): string {
  if (err && typeof err === 'object') {
    const e = err as NodeJS.ErrnoException & { dest?: string };
    if (typeof e.path === 'string' || typeof e.dest === 'string') {
      let message = typeof e.message === 'string' ? e.message : String(err);
      if (typeof e.path === 'string') message = translatePathIn(message, e.path, labels);
      if (typeof e.dest === 'string') message = translatePathIn(message, e.dest, labels);
      return message;
    }
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * The character class a granted directory must be followed by for the
 * backstop below to call it a leak.
 *
 * The question this answers is not "what ends a path" -- nothing does, on
 * Unix, where every byte except `/` and NUL is a legal filename character.
 * It is "what can follow a granted directory in a DIAGNOSTIC written by a
 * tool, in a way a sibling directory's longer name never would". The two
 * errors are not symmetric, and the class is deliberately biased toward the
 * cheaper one: a false positive costs one error message, replaced by the
 * generic refusal below; a false negative costs the host path itself, which
 * is the thing this whole module exists to prevent.
 *
 * Accepted, and why:
 *   `/`               a descendant path -- the original case.
 *   `\s` (incl. `\n`) any line or word break; a message that ends at the
 *                     path, or continues after a space.
 *   `:`               `<path>: <reason>`, which is what essentially every
 *                     Unix tool writes -- ripgrep, the C library's own
 *                     `perror` convention, Go, Rust. Its absence from this
 *                     class was issue #22: `rg: <granted root>: Permission
 *                     denied` walked straight through the backstop, while
 *                     the byte-identical message naming anything INSIDE
 *                     that root (followed by `/`) was caught.
 *   `'` `"` `` ` ``   a quoted path. Node's own errno messages quote:
 *                     `EACCES: permission denied, scandir '/granted/root'`,
 *                     so this is not hypothetical either.
 *   `,` `;`           list separators in a message naming several paths.
 *   `)` `]` `}` `>` `|`  a path closing a parenthetical, a bracketed
 *                     context, or the left half of an `a -> b` arrow.
 *
 * Deliberately NOT accepted -- every one of these is an ordinary character
 * *inside* a directory name, so accepting it would make the alarm fire on
 * an unrelated sibling that merely shares a prefix (`/allowed/project` vs
 * `/allowed/project-old`, the case the boundary test exists for): letters,
 * digits, `.`, `-`, `_`, `~`, `+`, `=`, `@`, `#`, `%`.
 *
 * Note what this does NOT try to be: a way to decide whether some substring
 * of free text IS a path. It only decides whether an occurrence of one
 * exact, already-known granted directory looks like that directory rather
 * than the head of a longer name. Anything more would be the whole-result
 * rewrite PR #10 removed, wearing a different hat.
 */
const PATH_BOUNDARY = "(?=[/\\s:,;'\"`)\\]}>|]|$)";

/**
 * Final backstop, not a translation mechanism: if an ERROR result somehow
 * still contains a literal granted host directory after every deliberate
 * translation site above, that is a bug -- something reached the client
 * from outside the grant, or a new call site was added without threading
 * `translatePathIn`/`describeError` through it -- and the right response to
 * a bug of that shape is to refuse to hand back the byte that proves it,
 * not to patch the message in place.
 *
 * Scoped to `isError` results ONLY. This is what keeps it from becoming the
 * whole-result rewrite this replaces: `fs_read`'s file content and
 * `fs_grep`'s content-mode matched lines are real file bytes that can
 * legitimately contain something that reads like the sandbox's own host
 * path (a config file, a log, a script mentioning its own location), and
 * every such case in this codebase is a SUCCESS result. Scanning success
 * results here would mean "the file you asked to read happens to mention
 * its own directory" and "fsmcp leaked a path from outside your grant"
 * both trip the same alarm -- which is exactly the failure PR #10 review
 * found (a legitimate read silently corrupted because its content matched
 * a host directory). Restricting the scan to `isError` avoids it entirely:
 * nothing in this codebase returns raw file content on an error path.
 *
 * A path-boundary lookahead (`PATH_BOUNDARY` above, and see its doc for the
 * exact class and the reasoning behind each character in it) avoids
 * flagging an unrelated sibling directory that happens to share a prefix
 * (`/allowed/project` inside `/allowed/project-old`).
 *
 * Both spellings of each grant are scanned (issue #21), for the same reason
 * `hostToVirtual` matches both: `realHostDir` is as much the granted
 * directory's real path as `hostDir` is, and under a symlinked root it is
 * the one a resolved-path leak would actually be spelled with. An alarm
 * that only knows the operator's spelling would have stayed silent on
 * exactly the deployments issue #21 is about.
 *
 * **This is an alarm, and a caller that relies on it is the bug.** Issue #22
 * is what that reliance looks like in practice: `fs_grep`'s ripgrep error
 * branch translated nothing and left this function to catch whatever `rg`
 * printed, so a one-character gap in the boundary class (no `:`) was the
 * only thing between a remote client and the host's real absolute path --
 * and in the cases where the alarm DID fire, its generic "this is a bug in
 * fsmcp" text was what an agent got for mistyping a directory name. Both
 * halves are fixed at that call site, where the paths are known; the class
 * was widened as defence in depth, not as the fix.
 */
export function redactLeakedHostPaths(result: MCPCallResult, labels: LabelEntry[]): MCPCallResult {
  if (!result.isError || labels.length === 0) return result;
  // `realHostDir` is absent on a LabelEntry built by hand (a unit test, or
  // any caller predating issue #21). Filter rather than assume: a missing
  // spelling must cost this alarm nothing, and `escapeRegExp(undefined)`
  // would throw from inside the one function whose job is to fail safe.
  const spellings = new Set(
    labels.flatMap(({ hostDir, realHostDir }) => [hostDir, realHostDir]).filter(Boolean)
  );
  const leaked = [...spellings].some((dir) => {
    const re = new RegExp(`${escapeRegExp(dir)}${PATH_BOUNDARY}`);
    return result.content.some((item) => re.test(item.text));
  });
  if (!leaked) return result;
  return errorResult(
    'fsmcp: internal error -- a result could not be produced without exposing a granted ' +
      'directory\'s real path. Refusing to return it. This is a bug in fsmcp, not a property of ' +
      'the request; please report it.'
  );
}
