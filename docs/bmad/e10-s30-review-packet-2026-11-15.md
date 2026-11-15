# E10-S30 Independent Review Packet — 2026-11-15

**Prepared by:** implementation owner (not the reviewer)
**Decision requested:** confirm or reject the R1 release gate against the evidence below.
**Authority:** `docs/bmad/sprint-status.yaml`, `docs/bmad/baseline-2026-07-24-gate0.md`,
`docs/bmad/progression-plan-2026-08-21.md`.

This packet exists so an independent reviewer can verify every gate without
reconstructing context. It is **not** a sign-off. Only E10-S30 may flip the release
decision.

## 1. Current recorded decision

`docs/bmad/releases/evidence/2026-11-15-release-evidence-ledger.json` records
`releaseDecision: blocked`. The blocker list is derived from the commands array, not
typed by hand. As of this packet it contains exactly two `not_run` records:

| Blocker | Why it is still open |
|---|---|
| `clean-machine-golden-path` | The executable golden path is green, but the drill has not been run on a pristine supported machine (Windows + Linux transcripts). |
| `security-triage-review` | This review. The reviewer is unassigned until you accept. |

Everything else passes. Do not accept the release on the presence of passing
commands alone; confirm the limitations in §5.

## 2. Reproduce the batch

```bash
# Toolchain: Node 22.x, pnpm 9.15.0 (repo engines + packageManager)
export PATH="$PWD/.local/toolchain/node22:$PWD/.local/toolchain/pnpm:$PATH"
unset PORT DATABASE_URL NEXUS_SQLITE_PATH NODE_ENV

# Optional: required only for the live PostgreSQL leg of the migration matrix.
# Use a disposable database; the matrix drops and recreates it.
export NEXUS_PG_URL="postgresql://USER:PASSWORD@127.0.0.1:5432/nexus_r1_matrix"

pnpm install --frozen-lockfile
pnpm --filter @agentic-os/sdk build      # server tests resolve the SDK from dist
pnpm exec tsx scripts/build-r1-evidence-v3.ts
pnpm exec tsx scripts/validate-r1-evidence-v3.ts
```

`validate-r1-evidence-v3.ts` must exit 0, every artifact must exist, and each
artifact's SHA-256 must match the ledger. The builder records the source commit it
was generated from; artifacts and ledger are committed together.

## 3. Passing commands (12 records)

| Command | What it establishes |
|---|---|
| `pnpm --filter @agentic-os/sdk build` | The SDK `dist` consumed by server tests matches the source under test. |
| `pnpm -r test` | All workspace suites pass: a2a 2 files, SDK 13 files, devtools 1 file, server 263 files. |
| `npx vitest run` (SDK) | SDK contract suite, including cross-platform path handling. |
| `pnpm -r typecheck` | Fresh non-incremental TypeScript across the workspace. |
| `pnpm -r lint` | Zero ESLint errors/warnings. |
| `scripts/scan-r1-documentation-claims.ts --check` | No unresolved release/perfection claims; findings=60, unresolved=0. |
| `scripts/test-r1-evidence-v3.ts` | Validator negative tests: 7/7 mutations rejected for the right reason. |
| `pnpm audit --prod --json` | **Zero** advisories of any severity (was 41, including critical `proxy-addr`). |
| `npx vitest run tests/e2e/golden-path.e2e.test.ts` | The 14-step governed path, 14/14 (see §4). |
| `node scripts/run-r1-migration-matrix.mjs` | 13/13: forward/rollback/reapply on SQLite, PGlite, PostgreSQL 18.7, plus `pg_dump` → rollback → `pg_restore` sentinel recovery. |

Artifacts live in `docs/bmad/releases/evidence/2026-11-15-*.log`; the ledger carries
their hashes.

## 4. What the 14-step golden path proves

`server/tests/e2e/golden-path.e2e.test.ts` runs the real SQLite-backed runtime through
the HTTP routers. It is not a mock walkthrough:

1. Project initialized and inspected (`mode: local`).
2. Three hashed source evidence records; six provenance-backed memories linked to them.
3. Durable task with idempotency key and a `created` event.
4. Lexical recall within a 1800-token budget (6 results, budget respected).
5. Risky write enters `waiting_approval`; **no file exists** before approval.
6. Approval re-validates action hash + policy version, then task resumes.
7. Approved write lands on disk with receipt and checkpoint.
8. Two low-risk reads are auto-allowed; no approval appears.
9. Constrained execution: real command on POSIX; **fail-closed** on Windows per ADR-0031.
10. Lease expiry with a new runtime instance: task returns to `queued`, checkpoint is
    retained, and replaying the same correlation ID returns the **same receipt** (no
    duplicate side effect).
11. Task reaches `completed`.
12. Timeline correlates task, approval, receipt and evidence entries.
13. Versioned export bundle passes import dry-run with zero conflicts/rejections.
14. Recall usefulness feedback is recorded and readable.

## 5. Explicit limitations — do not read these as passes

- **Windows constrained execution is not implemented.** Step 9 asserts the intended
  ADR-0031 fail-closed refusal. Real execution is proven only on POSIX (CI job).
- **pgvector integration suite not executed locally.** PostgreSQL 18.7 is installed but
  ships without pgvector; Docker Desktop cannot start because WSL2 is absent. The
  migration matrix is vector-independent and does not require pgvector.
- **The new CI job has not run.** `.github/workflows/validate.yml` adds
  `r1-postgres` (`pgvector/pgvector:pg16`, migration matrix, POSIX golden path). It is
  syntax-validated only; no CI execution exists yet.
- **Clean-machine drill not performed.** The executable path is green on the
  development host; W4-04 requires a pristine Windows and Linux machine transcript.
- **Playwright and coverage thresholds are not wired.** No claim is made about them.
- **This packet was written by the implementer.** Reviewer independence is the point.

## 6. Security review inputs

- `docs/bmad/security-triage-matrix-2026-08-24.md` — 12 findings, 6 remediated with
  evidence at the time of writing; confirm current status per finding.
- Production dependency audit is now clean (0 advisories), which supersedes the
  earlier CLAIMED-B2-CLOSED state that was measured false on 2026-11-15.
- Regression evidence for the critical advisory: `proxy-addr` is pinned to `^2.0.8`
  via root `package.json` → `pnpm.overrides` (pnpm 9 ignores `pnpm-workspace.yaml`
  overrides — that was the root cause of the stale claim).

## 7. Reviewer record

| Field | Value |
|---|---|
| Reviewer identity | _to be completed_ |
| Review date | _to be completed_ |
| Ledger commit reviewed | _to be completed_ |
| Decision | _approved / rejected_ |
| Conditions (if any) | _to be completed_ |
| Signature / attestation | _to be completed_ |

Until this table is complete and the ledger's `security-triage-review` record is
updated through the documented process, the release remains blocked.
