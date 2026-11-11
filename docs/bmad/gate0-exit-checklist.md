# Gate-0 Exit Checklist — live tracker

**Purpose:** single view of the five Gate-0 exit criteria (`docs/bmad/baseline-2026-07-24-gate0.md`)
mapped to their current evidence. Updated as waves land. The E10-S30 independent reviewer
(decision D2) signs against this document at Gate-0 exit.

Updated: 2026-11-10 (R1 migration CI evidence and requalification findings)

| # | Gate-0 exit criterion | Status | Evidence |
|---|---|---|---|
| 1 | All release/perfection claims reference baseline + ledger | ✅ Met | WS7 passes 1–3: primary guidance corrected and pointed at authority chain (`b82aa6f`); 14 campaign reports bannered (`899769c`); TASKBOARD reconciled (`9305dc4`). Residual: PLAN_TRACKER.md/sprint-status.yaml still carry pre-E10 narrative pending formal Lorekeeper mirror of the ratified plan (ratification itself committed `8024bdd`) |
| 2 | E10-S1…S5 stories have detailed AC + acceptance evidence | 🔶 Partial | Sprint-8 stories S1–S10 were in progress pre-stall; today's work supplies fresh evidence for S7/S8-class items (suite triage, audit). Story-by-story evidence pointers to be appended as waves commit |
| 3 | Every full-suite failure has owner, disposition, rerun evidence | 🔶 In progress | Windows inventory: 27 → **12** failing files today (Batch A `208bab7`, Forge `cef2c2d`, WS6 `010cf63`); Wave-2 agent repairing the remainder. Suite may only shrink; per-file before/after retained in commits |
| 4 | Release document carries no stale counts/claims | ✅ Met | R1-release-gate.md carries the 2026-07-24 supersession notice; campaign reports bannered; README badge/prereqs truthful |
| 5 | Evidence ledger reproducible + independently confirmed | 🔶 Pending | Ledger protocol active (transcripts `6f4f6c8`, audits, verification summaries); reviewer role defined (D2: external stateless agent per evidence batch) — first review batch fires at Gate-0 exit assembly |

## Blocker scoreboard

| Blocker | Status | Path to green |
|---|---|---|
| B1 full suite | 🔴 PR CI remains red after fixing runner setup | CI run `42964819231`: workspace tests, Playwright E2E, Rust, and server tests still fail. Server annotations include R1 policy/control expectations, sandbox 1s timeouts, and PostgreSQL contract mismatches. Resolve and rerun the authoritative matrix. |
| B2 dependency advisories | 🔴 Re-opened for reconciliation | Push-time GitHub notice reports **73 default-branch Dependabot alerts** (3 critical, 22 high, 42 moderate, 6 low); conflicts with the older clean-audit closure. Review current production dependency scope and retain a fresh alert export/audit before closing. |
| B3 migration rollback/restore | ✅ Migration matrix passed; overall CI suite still has unrelated failures | SQLite 3.40.1 SQL, native better-sqlite3 11.10.0 / SQLite 3.49.2, and PGlite 0.5.4 transcripts are retained below. Live PostgreSQL 16 drill step passed in CI run [42964819231](https://github.com/Warzonesiddiki/Agentic-OS-V3/actions/runs/42964819231); retained artifact: `r1-postgres-migration-drill` (90-day retention). The PGlite/live PostgreSQL checks use a minimal pre-R1 projects schema isolated from `public`; the CI drill passed before later server tests failed. |
| B4 clean-machine golden path | 🔶 Runbook ready | `9203cfe`; executes after B1 green on supported env |
| B5 security triage + independent review | 🔶 Matrix delivered | `668c925`+`695bb20`+`8b3132b`: 12 findings dispositioned (6 remediated w/ evidence); SEC-04 converts at next rerun; reviewer assigned (D2) |

## Rule

No criterion flips to ✅ without a ledger pointer. No blocker closes on local evidence alone
where a supported-environment (CI POSIX) run is required by its definition.
