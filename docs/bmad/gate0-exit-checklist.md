# Gate-0 Exit Checklist — live tracker

**Purpose:** single view of the five Gate-0 exit criteria (`docs/bmad/baseline-2026-07-24-gate0.md`)
mapped to their current evidence. Updated as waves land. The E10-S30 independent reviewer
(decision D2) signs against this document at Gate-0 exit.

Updated: 2026-11-15 (R1 evidence wave v3)

| # | Gate-0 exit criterion | Status | Evidence |
|---|---|---|---|
| 1 | All release/perfection claims reference baseline + ledger | ✅ Met | WS7 passes 1–3: primary guidance corrected and pointed at authority chain (`b82aa6f`); 14 campaign reports bannered (`899769c`); TASKBOARD reconciled (`9305dc4`). Claim scan is re-run in every ledger batch (`documentation-claim-scan`, findings=60, unresolved=0) |
| 2 | E10-S1…S5 stories have detailed AC + acceptance evidence | 🔶 Partial | S1–S10 evidence is carried by the v3 ledger command records and the tracker's per-task evidence column. Story-by-story AC mapping still needs the E10-S30 reviewer pass |
| 3 | Every full-suite failure has owner, disposition, rerun evidence | ✅ Met | Root `pnpm -r test` exit 0 — a2a 2 files, SDK 13 files / 257 tests, devtools 1 file, server 262 files / 2593 passing / 1 skipped. Artifact: `docs/bmad/releases/evidence/2026-11-15-full-suite.log` |
| 4 | Release document carries no stale counts/claims | ✅ Met | R1-release-gate.md carries the 2026-07-24 supersession notice; campaign reports bannered; README badge/prereqs truthful; claim scan exits 0 |
| 5 | Evidence ledger reproducible + independently confirmed | 🔶 Pending | v3 ledger (`2026-11-15-release-evidence-ledger.json`) executes every command in the batch, hashes each artifact, and validates with `scripts/validate-r1-evidence-v3.ts`. Reproducible ✅; independent confirmation ❌ — the E10-S30 reviewer is still unassigned |

## Blocker scoreboard

| Blocker | Status | Path to green |
|---|---|---|
| B1 full suite | ✅ CLOSED | Root `pnpm -r test` exit 0 (262 server files, 2593 passing, 1 skipped); SDK cross-platform path test fixed without weakening it. Evidence: `2026-11-15-full-suite.log` |
| B2 dependency advisories | ✅ CLOSED (re-earned 2026-11-15) | The earlier "no known vulnerabilities" claim was stale: the measured set was 41 advisories (1 critical, 10 high). Overrides in `package.json` → `pnpm.overrides` (the `pnpm-workspace.yaml` block pnpm 9 ignores), MCP SDK 1.32, Hono 4.13.16+, zod 4.6.6 migration. `pnpm audit --prod` now exits **0** with `{critical:0, high:0, moderate:0, low:0}`. Evidence: `2026-11-15-production-dependency-audit.log` |
| B3 migration rollback/restore | 🔶 SQLite + live PostgreSQL green; PGlite forward-only | `scripts/run-r1-migration-matrix.mjs`: 8/8 checks — forward 0049→0054, rollback 0054→0049, base preserved, reapply, on SQLite and PostgreSQL 18.7. Fixed three real rollback defects found by the drill (SQLite-incompatible `DROP COLUMN IF EXISTS`; rollback dropping base-owned `projects` columns). PGlite forward is covered by `server/tests/r1-effect-claims-contract.test.ts`; live pgvector integration remains open (pgvector is unavailable in the local PostgreSQL 18 install) |
| B4 clean-machine golden path | 🔶 Runbook ready | `9203cfe`; the real 14-step test (W4-01) is not yet implemented |
| B5 security triage + independent review | 🔶 Matrix delivered | `668c925`+`695bb20`+`8b3132b`: 12 findings dispositioned. Reviewer still unassigned (E10-S30) |

## Environment notes

- PostgreSQL 18.7 is running locally on `127.0.0.1:5432`; the migration drill uses the disposable
  `nexus_r1_matrix` database. Credentials are supplied through `NEXUS_PG_URL` at run time and are
  never written to the repository or to evidence artifacts.
- Docker Desktop is installed, but its Linux engine cannot start because WSL2 is not installed on
  this machine. Docker is therefore **not** a usable CI substitute here; the local PostgreSQL 18
  server is used instead.
- The local PostgreSQL installation does not ship pgvector, so the full-schema `db:push` +
  integration suite (`server/tests/integration`) still needs a pgvector-enabled database in CI.

## Rule

No criterion flips to ✅ without a ledger pointer. No blocker closes on local evidence alone
where a supported-environment (CI POSIX) run is required by its definition.
