# Traceability matrix — ACCEPTANCE.md to tests

One row per acceptance ID (the "Dead — do not port" section is excluded, as
instructed there). "Test" names a Go test function unless marked
**(harness)**, in which case it names a `testkit/` script and section —
those do not run in `go test ./...` / CI, only `go test` does.

Legend: **covered** — a test genuinely asserts the hazard. **partial** —
something related is tested but not the specific hazard. **missing** —
nothing covers it. Every row below is the state *after* this pass; the
"Before" column records what it was when this audit started.

## A. Containment

| # | case | Test | Before | After |
|---|---|---|---|---|
| A1 | absolute path (`/etc/passwd`) | `TestStatLeadingSlashStaysInsideRoot` | covered | covered |
| A2 | `..` traversal, any depth | `TestRootRefusesDotDotEscape`, `TestStatDotDotEscapeRefused`, `TestListDotDotEscapeRefused`, `TestNoRootPathLeak` (20-deep case) | covered | covered |
| A3 | symlink → outside **file**, target exists | `TestRootRefusesRelativeSymlinkEscapingToFile` | **missing** | covered |
| A4 | symlink → outside, target **dangling** | `TestRootRefusesRelativeSymlinkEscapingDangling` | **missing** | covered |
| A5 | symlink → outside **directory** | `TestRootRefusesEscapeThroughSymlinkedDir`, `TestReadEscapingSymlinkRefused`, `TestListEscapingSymlinkRefused`, `TestStatEscapeThroughSymlinkedDirRefused`, `TestRootRefusesRelativeSymlinkEscapingToDirectory` | covered | covered |
| A6 | symlink cycle — refused, no hang | `TestRootRefusesSymlinkCycleWithoutHanging` | **missing** (containment.sh's A6 used `fs_stat`/lstat, which never follows the link, so it never actually walked the cycle) | covered |
| A7 | NUL byte in path | `TestNormalizePath`, `TestReadNulByteRefused`, `TestStatNulByteRefused`, `TestMkdirNulByteRefused`, `TestGrepPatternNulByteRefused`, `TestGlobNulByteInPatternRefused` | covered | covered |
| A8a | relative symlink staying inside works | `TestRootFollowsRelativeSymlinkInsideRoot` | **missing** — worse, the existing `link-in` fixture (docstring: "a symlink pointing inside the root") is itself absolute, so no test could have shown A8a passing | covered |
| A8b | absolute symlink, even pointing inside, refused | `TestRootRefusesAbsoluteSymlinkEvenPointingInside` | **missing** (only `Lstat` on `link-in` was ever exercised, which never follows it) | covered |
| A8c | symlink as a search directory refused | `TestSearchDirRefusesASymlinkThatResolvesInsideTheRoot` | **missing** | covered |
| A8d | escaping symlink as a search dir carries no `scope_violation` | `TestSearchDirEscapingSymlinkReportsNotADir` | **missing** | covered |
| A9 | root addressable as `.` and `""` | `TestStatRootItself`, `TestListRootDirectory`, `TestMkdirRootIsANoOpSuccess`, `TestNormalizePath` | covered | covered |
| A10 | leak test — every tool, no root path in any output | `TestNoRootPathLeakAllTools` (new; runs all 10 registered tools through several failure modes each), `TestNoRootPathLeak` (fs_stat only) | **partial** — the only existing test (`TestNoRootPathLeak`) drove `fs_stat` and one unregistered-tool-name case; it never called `fs_write`, `fs_replace`, `fs_move`, `fs_delete`, `fs_glob`, `fs_grep`, `fs_mkdir`, `fs_list`, `fs_read` at all | covered |

## B. Data destruction — `fs_move`

| # | case | Test | Before | After |
|---|---|---|---|---|
| B1 | case-only rename succeeds, content intact | `TestMoveCaseOnlyRenameSucceeds` | covered | covered |
| B2 | case-only rename of a directory | `TestMoveCaseOnlyRenameOfDirectorySucceeds` | covered | covered |
| B3 | literal self-move refused, `invalid_argument` | `TestMoveLiteralSelfMoveRefused`, `TestMoveLiteralSelfMoveViaLeadingSlashRefused` | covered | covered |
| B4 | destination exists (file), `exists` | `TestMoveDestinationExistsFileRefused` | covered | covered |
| B5 | destination exists (non-empty dir), `exists` | `TestMoveDestinationExistsNonEmptyDirRefused` | covered | covered |
| B6 | a move that fails for any reason: both sides intact | `TestMoveFailureLeavesSourceAndDestinationIntact` (new: destination's parent missing) | **partial** — only the "exists" failure mode (B4/B5) demonstrated "both intact"; no test exercised a distinct failure cause | covered |
| B7 | root as source or destination, refused | `TestMoveRootAsSourceRefused`, `TestMoveRootAsDestinationRefused` | covered | covered |

## C. Corruption — atomic replace

| # | case | Test | Before | After |
|---|---|---|---|---|
| C1 | xattrs preserved (`xattr -l` identical) | `TestAtomicReplacePreservesXattrAndACL` | covered | covered |
| C2 | ACL preserved (`ls -le` identical) | `TestAtomicReplacePreservesXattrAndACL` | covered | covered |
| C3 | exact mode bits survive umask (0644/0600/0755) | `TestAtomicReplacePreservesExactModeUnderUmask` | covered | covered |
| C4 | setuid dropped on replace | `TestAtomicReplaceDropsSetuid` | covered | covered |
| C5 | attrs unpreservable → write refused, file unchanged | `TestAtomicReplaceNoTempFileLeftAfterAttrFailure` | covered | covered |
| C6 | write fails partway → original intact, no temp file | `TestAtomicReplaceWritePartwayFailureLeavesOriginalIntact` (new; `RLIMIT_FSIZE` forces `write(2)` to fail mid-write deterministically) | **missing** | covered |
| C7 | concurrent writes never tear | `TestAtomicReplaceConcurrentWritesNeverTear` (new) | **missing** — no test anywhere touched concurrency | covered |
| C8 | no temp file survives any failure path | `TestAtomicReplaceNoTempFileLeftAfterSuccess`, `TestAtomicReplaceNoTempFileLeftAfterAttrFailure`, `TestAtomicReplaceRefusesUndeletableTarget`, `TestAtomicReplaceWritePartwayFailureLeavesOriginalIntact` | covered | covered |

Hard-link-breaks-on-replace ("known and deliberate", not independently
numbered) is pinned by `TestAtomicReplaceBreaksHardLink`.

## D. Byte fidelity

| # | case | Test | Before | After |
|---|---|---|---|---|
| D1 | PNG round-trips `fs_read` → `fs_write`, byte-identical | `TestReadThenWriteRoundTripsPNGByteIdentical` (new) | **partial** — `testkit/fidelity.sh` (harness, non-asserting: prints `MATCH`/`MISMATCH`, never fails the run) only exercised `fs_read`; nothing fed the result back through `fs_write` | covered |
| D2 | BOM preserved across `fs_replace` | `TestReplacePreservesBOMCRLFAndMissingFinalNewline` | covered | covered |
| D3 | CRLF preserved across `fs_replace` | `TestReplacePreservesBOMCRLFAndMissingFinalNewline` | covered | covered |
| D4 | missing final newline preserved | `TestReplacePreservesBOMCRLFAndMissingFinalNewline` | covered | covered |
| D5 | multi-byte UTF-8 preserved | `TestReadWholeMultiByteUTF8FileIsPreservedExactly` (new) | **missing** | covered |
| D6 | byte range splitting a multi-byte rune → base64, not repaired | `TestReadRangeSplittingMultiByteRuneIsBase64` | covered | covered |
| D7 | `range_sha256` matches returned bytes, always | `TestReadWholeFileUTF8`, `TestReadPartialHasNoWholeFileSHA256`, `TestReadNonUTF8IsBase64AndByteIdentical` | covered | covered |
| D8 | whole-file `sha256` present only when read covers whole file | `TestReadWholeFileUTF8`, `TestReadPartialHasNoWholeFileSHA256` | covered | covered |
| D9 (inverted) | `fs_replace` succeeds on a non-UTF-8 file; other bytes untouched | `TestReplaceNonUTF8FileSucceeds` | covered | covered |
| D10 (inverted) | a long line comes back whole, not truncated | `TestReadLongLineComesBackWholeNotTruncated` (new) | **partial** — only `testkit/fidelity.sh` (harness, non-asserting) printed the size/length/eof for a human to read | covered |

## E. `fs_replace` semantics

| # | case | Test | Before | After |
|---|---|---|---|---|
| E1 | empty `find` refused | `TestReplaceEmptyFindRefused` | covered | covered |
| E2 | `find == replace` refused | `TestReplaceIdenticalFindReplaceRefused` | covered | covered |
| E3 | `find` occurs zero times → `no_match` | `TestReplaceZeroMatchesRefused` | covered | covered |
| E4 | `find` occurs twice, no `all` → `ambiguous_match`, count named | `TestReplaceAmbiguousWithoutAllRefused` (code), `TestReplaceAmbiguousMatchNamesTheCount` (new: message names the count) | **partial** — code was checked, "count named" was not | covered |
| E5 | `find` occurs twice, `all: true` → both replaced, `counts: [2]` | `TestReplaceAllTrueReplacesEveryOccurrence` | covered | covered |
| E6 | empty `replace` is a deletion | `TestReplaceEmptyReplaceIsADeletion` | covered | covered |
| E7 | batch, edit 2 fails → nothing written | `TestReplaceBatchAllOrNothing` | covered | covered |
| E8 | batch, all succeed → one write, `counts` per edit | `TestReplaceBatchAllSucceedIsOneAtomicWriteWithCountsPerEdit` (new; 2 distinct edits) | **partial** — existing tests exercised one edit, or one edit repeated 3x; nothing proved a *multi-edit* batch's per-edit `counts` | covered |
| E9 | `if_sha256` mismatch → `precondition_failed`, nothing written | `TestReplaceHashPreconditionMismatch` (code), `TestReplaceHashPreconditionMismatchWritesNothing` (new: content unchanged) | **partial** — only the code was checked | covered |
| E10 | `if_sha256: null` on existing file → `exists` | `TestReplaceNullPreconditionOnExistingFileRefused` (code), `TestReplaceNullPreconditionOnExistingFileWritesNothing` (new: content unchanged) | **partial** — only the code was checked | covered |
| E11 | `if_sha256` absent → schema violation | `TestReplaceIfSHA256AbsentRefused`, `TestWriteIfSHA256AbsentRefused` | covered | covered |

## F. Search — injection and honesty

| # | case | Test | Before | After |
|---|---|---|---|---|
| F1 | shell metacharacters in a pattern matched literally, no shell | `TestGrepPatternWithShellMetacharactersNeverInvokesAShell` (new) | **partial** — `TestGrepMatchedTextIsNeverAltered` put the metacharacters in file *content*, matched with an *escaped* pattern; nothing put them in the pattern argument itself. `testkit/search-escape.sh` (harness) does assert this one (`/tmp/pwned_search` check) | covered |
| F2 | command substitution / backticks in a pattern | `TestGrepPatternWithShellMetacharactersNeverInvokesAShell` | **partial** (same as F1) | covered |
| F3 | shell redirect in a pattern writes no file | `TestGrepPatternWithShellMetacharactersNeverInvokesAShell` | **partial** (same as F1) | covered |
| F4 | newline in a pattern is one argv element, not two | `TestGrepPatternWithEmbeddedNewlineIsOneArgvElement` (new; stand-in `rg` records argv) | **missing** | covered |
| F5 | NUL byte in a pattern → clean refusal, not a panic | `TestGrepPatternNulByteRefused` | covered | covered |
| F6 | absolute glob pattern refused | `TestGlobAbsolutePatternRefused`, `TestGrepGlobAbsoluteRefused`, `TestValidateGlobArg` | covered | covered |
| F7 | glob pattern aimed above the root (`../*`) refused | `TestGlobDotDotPatternRefused`, `TestGrepGlobDotDotRefused`, `TestValidateGlobArg` | covered | covered |
| F8 | brace alternative smuggling an absolute path | `TestGlobBraceSmugglingRefused`, `TestValidateGlobArg` | covered | covered |
| F9 | truncated search says so (`truncated: true`) | `TestGrepMaxMatchesTruncates`, `TestGrepDefaultMaxMatchesIs200`, `TestParseFileListTruncates`, `TestParseMatchesTruncates` | covered | covered |
| F10 | search matching nothing → explicit empty result, never an error | `TestGrepNoMatchIsEmptySuccess`, `TestGlobNoMatchIsEmptySuccess` | covered | covered |
| F11 | search that could not run → an error, never empty success | `TestGrepMissingPathIsError`, `TestGrepUnreadablePathIsError`, `TestGlobMissingPathIsError`, `TestGlobUnreadablePathIsError`, `TestGrepInvalidRegexIsRejected`, `TestRunRGBadPatternFails` | covered | covered |
| F12 | `rg` timeout → error naming the timeout, never silent partial | `TestGrepTimeoutIsAnErrorNamingTheTimeout`, `TestRunRGTimesOut` | covered | covered |
| F13 | filename containing a newline → one intact entry | `TestGrepHostileFilenameNewlineIsOneIntactEntry`, `TestGlobHostileFilenameNewlineIsOneIntactEntry` | covered | covered |
| F14 | search dir named like a flag | `TestGrepSearchDirNamedLikeAFlagDoesNotLeaveTheRoot`, `TestGlobSearchDirNamedLikeAFlagDoesNotLeaveTheRoot`, `TestAppendSearchDirEndsTheFlagsFirst` | **missing** | covered |
| F15 | search dir named `--pre=/bin/sh` | `TestGrepSearchDirCannotMakeRGRunACommand` | **missing** | covered |
| F16 | dotfile visible to `fs_grep` | `TestSearchSeesHiddenFiles` | **missing** | covered |
| F17 | ignore file inside the root | `TestSearchIsNotFilteredByAnIgnoreFileInsideTheRoot` | **missing** | covered |
| F18 | ignore file above the root | `TestSearchIsNotFilteredByAnIgnoreFileAboveTheRoot` | **missing** | covered |

## G. Deletion

| # | case | Test | Before | After |
|---|---|---|---|---|
| G1 | delete the root itself refused | `TestDeleteRootRefused` | covered | covered |
| G2 | non-empty directory without `recursive` refused | `TestDeleteNonEmptyDirWithoutRecursiveRefused` | covered | covered |
| G3 | recursive delete unlinks a symlink, never descends through it | `TestDeleteRecursiveUnlinksSymlinkWithoutDescending`, `TestDeleteSymlinkItselfUnlinked` | covered | covered |
| G4 | `if_sha256` mismatch on a file → refused, file intact | `TestDeleteHashMismatchRefused` | covered | covered |

## H. Protocol surface

| # | case | Test | Before | After |
|---|---|---|---|---|
| H1 | every tool publishes `readOnlyHint`/`openWorldHint` as explicit booleans | `TestToolsListAnnotationsAlwaysExplicit` (new; drives the real `run()`/registration) | **missing** — `proto.TestToolAnnotationsAlwaysPresent` only checked a synthetic, hand-built `Tool`, never the real registered set | covered |
| H2 | `--read-only` registers exactly the 5 read-only tools; a write tool is absent from `tools/list` | `TestReadOnlyFlagRegistersExactlyFiveReadOnlyTools` (new) | **missing** | covered |
| H3 | over-budget response → JSON-RPC error, never truncated | `TestOverBudgetResponseBecomesJSONRPCError` (new) | **missing** | covered |
| H4 | malformed JSON on stdin → `-32700`, server stays up | `TestMalformedJSONIsParseErrorAndServerStaysUp` (new) | **missing** | covered |
| H5 | unknown method + id → `-32601`; notification → no reply | `TestUnknownMethodAndNotificationHandling` (new) | **missing** | covered |
| H6 | `_meta.args_sha256` mismatch → `integrity_failed`, nothing executed | `TestRegistryArgsSHA256MismatchRefusesIntegrityFailed` (new) | **missing** — no test touched `Registry.Call`'s `_meta` handling at all | covered |
| H7 | `_meta.args_sha256` absent → call proceeds normally | `TestRegistryArgsSHA256AbsentProceedsNormally` (new) | **missing** | covered |
| H8 | a panic in one call is caught as `io_error`; server survives | `TestPanicInOneCallDoesNotKillServer` (new, over the real `serve()` stdio loop), `TestRegistryPanicInHandlerIsCaughtAsIOError` (new, unit-level) | **missing, and the product itself had no `recover()` anywhere** — see "Production fix" below | covered |

---

## Production fix required for H8

`internal/fsapi/registry.go`'s `Registry.Call` had **no panic recovery at
all** before this pass — the gap ACCEPTANCE.md's H8 note describes ("v2 had
a live crash where a malformed `_meta` threw outside the handler's `try`
and killed the process") was reproducible in v3 too, by construction: any
handler panic would have propagated out of `Call`, out of `handleLine`, out
of `serve`'s loop, and taken the whole process down on one bad call. Since
closing this gap with only a test would have meant writing a test that
fails, `Call` now wraps the handler dispatch in a `recover()` that returns
`io_error`. This is the one non-test change in this pass; it is minimal
(one `defer` block) and centrally located, since every `tools/call` in the
whole server funnels through this one function.

## Harnesses: what actually asserts vs. what only prints

Per `CLAUDE.md`'s own testing section, four `testkit/` scripts exist:
`containment.sh`, `fidelity.sh`, `search-escape.sh`, `mutation.py` (plus
`leakscan.sh` and `drive.py`, not directly named by this task, and
`layer3.py`, which drives a separate relay/hermes stack and is out of
scope here).

**Only `mutation.py` and `leakscan.sh` actually assert anything.**
`mutation.py` tracks failures explicitly (`check(...)` appends to a `FAILS`
list; `sys.exit(1 if FAILS else 0)`), and `leakscan.sh` `exit 1`s on a leak.

`containment.sh`, `fidelity.sh`, and most of `search-escape.sh` **print
`OK`/`REFUSE`/`MATCH`/`MISMATCH`/`PASS`/`FAIL`-looking text and exit 0
regardless of what they saw.** A wrong answer from fsMCP running under
these three scripts produces the same exit code as a right one — a human
has to read the output. This is exactly the failure mode
`CLAUDE.md`/ACCEPTANCE.md's spirit warns about ("assert that the operation
actually succeeded before asserting what it preserved"), just one level up:
a harness that *looks* like a regression test but isn't one reads as green
in CI even though nothing runs it in CI. Two consequences:

1. Every row in this matrix that cites a harness now also has a `go test`
   covering it directly — no row in the final matrix depends solely on a
   non-asserting harness.
2. `mutation.py`'s own coverage is narrower than its section comments
   suggest: several `show(...)` calls (print-only) sit next to a much
   smaller number of `check(...)` calls (real assertions) in the same
   section. For example the `"E4/E5/E7/E9/E10/E11"` section only actually
   asserts E7 (`check("E7 nothing written", ...)`); E4, E5, E9, E10, E11 are
   `show()`-only in that script. Likewise the G section only asserts the
   G3 containment claim (canary intact), not that G1/G2 were refused.
   `mutation.py` is not listed as the covering test for those specific
   sub-claims in this matrix; the Go tests are.

None of this blocks deleting the TypeScript suite — every row above has a
real `go test`. It does mean `containment.sh`/`fidelity.sh` should not be
treated as CI-equivalent to the Go suite; they remain useful as an
eyeballed sanity check against a real `rg` and a real disk, nothing more.
