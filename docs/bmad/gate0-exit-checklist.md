# Gate-0 Exit Checklist — live tracker

**Purpose:** single view of the five Gate-0 exit criteria (`docs/bmad/baseline-2026-07-24-gate0.md`)
mapped to their current evidence. Updated as waves land. The E10-S30 independent reviewer
(decision D2) signs against this document at Gate-0 exit.

Updated: 2026-08-24 (WS execution day 1)

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
| B1 full suite | 🔶 12 files left locally (243/255 pass) | Wave-2 → full rerun → push → CI ubuntu/Node22 authority run (also delivers WS0 POSIX twin + WS8 enforcement) |
| B2 dependency advisories | ✅ CLOSED | `ab38fb7` + clean re-audit `1178750` ("No known vulnerabilities found") |
| B3 migration rollback/restore | 🔶 Partial: SQLite SQL, native better-sqlite3, and PGlite legs passed; live PostgreSQL pending | SQLite 3.40.1: `2026-11-10-r1-sqlite-migration-drill.log`; better-sqlite3 3.49.2: `2026-11-10-r1-better-sqlite3-migration-drill.log`; PGlite 0.5.4: `2026-11-10-r1-pglite-migration-drill.log`. A schema-isolated PostgreSQL drill is now wired into `server-validate`; its transcript will be retained as CI artifact `r1-postgres-migration-drill`. Await the live PostgreSQL result; PGlite fixture remains a modeled baseline. |
| B4 clean-machine golden path | 🔶 Runbook ready | `9203cfe`; executes after B1 green on supported env |
| B5 security triage + independent review | 🔶 Matrix delivered | `668c925`+`695bb20`+`8b3132b`: 12 findings dispositioned (6 remediated w/ evidence); SEC-04 converts at next rerun; reviewer assigned (D2) |

## Rule

No criterion flips to ✅ without a ledger pointer. No blocker closes on local evidence alone
where a supported-environment (CI POSIX) run is required by its definition.
