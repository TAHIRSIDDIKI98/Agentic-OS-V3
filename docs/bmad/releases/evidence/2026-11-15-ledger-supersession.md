# Ledger supersession — 2026-07-24 v2 → 2026-11-15 v3

**Status:** the 2026-07-24 v2 ledger is **superseded and non-reproducible**. It remains in the
repository as history and must not be used as release evidence.

## Why it is superseded

Measured on 2026-11-15 against commit `d467777dca79f7d88ca193c7be0b02b43558d02e`, the commit the v2
ledger cites as its evidence source:

| Check | Result |
|---|---|
| Artifacts referenced | 31 unique files |
| Present in the cited commit | 1 (`2026-07-24-unperformed-release-gates.md`, hash matches) |
| Absent from the cited commit | 25 (logs were produced in a working tree that was never committed) |
| Present but hash-mismatched | 5 (triage JSON, claim-scan JSON, and logs changed after hashing) |

A ledger whose artifacts are not in the repository cannot be reproduced by any reviewer, and a
checksum that cannot be verified is not integrity evidence. Re-hashing today's files would have
*silently legitimised* a batch that no longer matches what was executed, so that option was rejected.

## What replaces it

`docs/bmad/releases/evidence/2026-11-15-release-evidence-ledger.json`
(schema `nexus.r1.release-evidence-ledger.v3`), produced by `scripts/build-r1-evidence-v3.ts`:

- every command in the ledger was executed by that script in one batch;
- every raw output is written to a dated artifact in this directory;
- every artifact hash is computed from the committed bytes;
- `releaseDecision` is derived from the command statuses and cannot be hand-edited without failing
  validation;
- `not_run` records carry the reason and keep the decision `blocked`.

Validation: `pnpm exec tsx scripts/validate-r1-evidence-v3.ts`.

Negative tests: `pnpm exec tsx scripts/test-r1-evidence-v3.ts` — proves the validator rejects a
nonzero-exit pass, a path escape, a forged hash, manual approval, a wrong blocking list, and a
`not_run` record with an exit code.

## Reproducibility rule going forward

1. Run `scripts/build-r1-evidence-v3.ts`.
2. Commit the artifacts and the ledger **in the same commit**.
3. Never edit a committed artifact; supersede it with a new dated batch.

`.gitattributes` marks `docs/bmad/releases/evidence/**` as `-text` so checkout on Windows cannot
rewrite line endings and break SHA-256 verification.
