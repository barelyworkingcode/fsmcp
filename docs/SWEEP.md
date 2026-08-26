# Final sweep

Runs last, after Layer 3 verifies. Nothing here is deleted while it is still
the only working implementation.

The rule for every item: **the code carries the present tense.** If something
describes a version that no longer exists, it goes. If the reasoning behind it
still matters, it moves into `DESIGN.md` or `INTEGRATION.md` first — as
present-tense reasoning, not as a bug story.

## fsMCP — delete outright

| path | size | note |
|---|---|---|
| `src/` | 424K | the whole v2 TypeScript implementation |
| `tests/` | 484K | superseded by Go tests; hazards already carried into `ACCEPTANCE.md` |
| `node_modules/` | 31M | |
| `dist/` | 444K | |
| `package.json`, `package-lock.json`, `tsconfig.json` | | |

Do not delete `tests/` until every hazard in `ACCEPTANCE.md` has a passing Go
test. `ACCEPTANCE.md` is the receipt that the intent survived; the traceability
check is that each of its rows names the Go test that covers it.

## fsMCP — rewrite

- **`README.md`** — describes the virtual `/d0/…` path space, `_meta.allowed_dirs`,
  the text/base64 encoding argument, `fs_edit` and `fs_find`. None of it is
  true. Rewrite from `DESIGN.md`, short.
- **`CLAUDE.md`** — same, plus a `src/` file map that will not exist.
- **`build.sh`** — Node build and install; becomes `go build` plus the relay
  registration.
- **`.gitignore`** — Node ignores become Go ignores.

## fsMCP — comment sweep of the new code

The new code is written to the comment rule from the start, so this is a check,
not a cleanup. Grep the Go tree for: issue numbers (`#\d+`), the words
`used to`, `previously`, `earlier version`, `this used to`, `the bug this`, and
any comment longer than about five lines. Each hit is either deleted or moved
into `DESIGN.md`.

## relay

Two different kinds of document, and they must not be treated the same.

**Correct these — they describe current behaviour:**

- `docs/access-profiles.md` — operator guidance for granting fsMCP; the whole
  directory-as-scope-value model is replaced by one-MCP-per-directory.
- `docs/context-schema.md` — uses fsMCP as its worked example of a v2 schema.
  fsMCP no longer publishes one. Needs a different example, and a note that a
  schema-less MCP is a legitimate and supported shape.
- `docs/audit-log.md` — must document the root stamped by R2.
- `docs/testing-roadmap.md`, `README.md`, `CLAUDE.md` — references to fsMCP's
  surface.

**Leave these alone — they are decision records:**

- `docs/decisions/005`, `010`, `011`, `012`, `013`.

An ADR is a dated record of what was decided and why, and rewriting it destroys
the thing it exists to preserve. Where an ADR's *consequence* no longer holds —
ADR-011's fsMCP scope example, ADR-013's fsMCP surrogate case — add a dated
superseding note at the end. Never edit the body.

ADR-013 is the one to be careful with: it is the justification for the
`args_sha256` check, and its worked example is the corruption it caught. That
example stays.

## relayRemote

- No hardcoded fsMCP references in `*.go` or `*.md` — confirmed by grep, so
  nothing to sweep in source.
- **Generated skills** describe the v2 tool surface and are regenerated, not
  edited (INTEGRATION.md C3).

## Sibling directories

These are outside all three repos, in `~/source/barelyworkingcode/`.

- `fsmcp-review/` — the v2 integration review: briefs, fixtures, and `findings/`.
  **Archive, do not delete.** It is the evidence that produced `ACCEPTANCE.md`,
  and several findings are still the only written record of why a rule exists.
  Its `BRIEF.md`/`REPAIR-BRIEF.md`/`STATUS.md` are v2 work-tracking and can go;
  `findings/` should be kept somewhere durable.
- `fsmcp-worktrees/` — empty; remove.
- `testfolder/`, `testfolder_sibling_canary.txt`, `outside_secret` — v2 manual
  test fixtures, superseded by `testkit/mkfixture.sh`. Remove once Layer 3
  passes.

`RUNBOOK-vm-stack.md` pins `fsmcp 6624526 (present, not wired in)`. Update the
commit, and change that parenthetical once fsMCP is actually wired into the
stack.

## Ordering

1. Layer 3 passes.
2. Traceability check: every `ACCEPTANCE.md` row names a passing Go test.
3. Delete `src/`, `tests/`, and the Node scaffolding.
4. Rewrite fsMCP's own docs.
5. Correct relay's current-state docs; append superseding notes to ADRs.
6. Regenerate relayRemote's skills.
7. Sibling directories and the runbook.
