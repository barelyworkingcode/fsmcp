# v2 integration review — archived findings

The review of fsMCP v2 that produced the v3 rewrite. Kept because for several
rules in `DESIGN.md` this is the only written record of the failure that
motivated them, and because `ACCEPTANCE.md` was built from these documents.

**Historical.** Every finding here is against an implementation that no longer
exists. Nothing in it describes current behaviour. Read `DESIGN.md` for what
fsMCP does now, and `ACCEPTANCE.md` for which of these hazards are still tested
— including the ones v3 deliberately **inverts**, such as editing a file that
is not valid UTF-8, which v2 refused and v3 supports.
