# NEXUS 2.0 — Execution Tracker (2026-11-15)

> **What this document is:** an operational task tracker for finishing the project. It is **not**
> release evidence and it does not change any story status. The authority chain remains:
> `docs/bmad/baseline-2026-07-24-gate0.md` → `docs/bmad/progression-plan-2026-08-21.md` →
> `docs/bmad/sprint-status.yaml` → `docs/bmad/releases/evidence/2026-07-24-release-evidence-ledger.json`.
> Only the independent E10-S30 reviewer can flip the release decision.
>
> **Rule of this tracker:** a task is `✅` only when its acceptance command was run and its raw
> output is retained. "Implemented" is not "done". "Targeted green" is not "gate green".

---

## 0. Audit snapshot — measured, not assumed

Environment: Windows 11, git `main` @ `b7b1dcf5`, working tree has 8 modified + 2 untracked files,
Node `v22.23.5` (pinned toolchain in `.local/`), pnpm `9.15.0`. PostgreSQL 18.7 is now running
locally on `127.0.0.1:5432`. Docker Desktop is installed, but its Linux engine cannot start because
WSL2 is not installed on this machine.

| Check | Command | Observed | Verdict |
|---|---|---|---|
| Server suite | `cd server && npx vitest run` | **262 files passed, exit 0** | ✅ green locally |
| SDK suite | `cd packages/sdk && npx vitest run` | **1 failed / 12 passed**; `r1-serena.test.ts > getSymbolInfo > handles absolute and relative file paths` | 🔴 red (Windows path assumption) |
| Root suite | `pnpm -r test` | fail-fast at the SDK failure; server never reached | 🔴 red |
| Typecheck | `pnpm typecheck` | exit 0 | ✅ |
| Lint | `pnpm lint` | exit 0 | ✅ |
| Doc claim gate | `pnpm exec tsx scripts/scan-r1-documentation-claims.ts --check` | **exit 1** — 61 findings, **1 unresolved** (`docs/bmad/security-triage-matrix-2026-08-24.md:19`) | 🔴 red |
| Evidence ledger validator | `pnpm exec tsx scripts/validate-r1-release-evidence.ts` | **exit 1** — checksum mismatch: `docs/bmad/releases/evidence/2026-07-24-e10-s8-s9-full-suite-final.log` | 🔴 red |
| Validator negative tests | `pnpm exec tsx scripts/test-r1-release-evidence-validator.ts` | **exit 1** — `pass-with-nonzero-exit: validator failed without the mutation-specific diagnostic` | 🔴 red (validator regressed) |
| Dependency audit | `pnpm audit --prod` | **exit 0** — 41 advisories remediated to **0** (critical `proxy-addr`, MCP SDK, Hono, fast-uri, zod 4) | ✅ green |
| Down migrations | `server/src/db/migrations/down/` | 0049–0054 present in **both** `.sql` and `.sqlite.sql` + README | ✅ authored (drill not run) |
| Migration drill | `node scripts/run-r1-migration-matrix.mjs` | **8/8** — forward, rollback, base preserved, reapply on SQLite and PostgreSQL 18.7 | ✅ green |
| Golden-path drill | ledger `clean-machine-drill` | `not_run` | 🔴 no evidence |
| Security triage | ledger `security-triage` vs Gate-0 checklist | checklist says "matrix delivered"; ledger says `not_run`; claim scan flags line 19 | 🟡 conflicting, unverified |
| CI suite job | `.github/workflows/validate.yml` | runs `pnpm -r test` on ubuntu + **Node 20** while repo pins `^22.x` | 🟡 drift |
| Coverage gate | `server/vitest.config.ts` | thresholds 80% configured, **never enforced in CI** | 🟡 configured only |
| E2E | `playwright.config.ts` + `e2e/` | config exists; **no CI job**; `server/tests/e2e` holds only `system.e2e.test.ts`, not the 14-step path | 🟡 not enforced |
| R1 code stubs | grep `TODO/FIXME/placeholder` in `r1-*` | **0 hits** | ✅ |
| R1 `any` | grep `: any` in `r1-*` | **1** (`packages/sdk/src/r1-evidence-timeline.ts`) | 🟡 nearly clean |
| Uncommitted work | `git status` | Phase-1 fixes (`audit.ts`, `kernel.ts`, `llm.ts`, `operations-ext.ts`, `vitest.config.ts`, tests) still uncommitted | 🟡 |

### Findings that change the plan

1. **The truth machine is broken, and it is the real blocker.** The claim scan, the ledger
   validator, and the validator's own negative tests are all red. Until these are green, no amount
   of product work can be *proven*, and Gate-0 criterion 5 (reproducible ledger) cannot pass.
2. **The ledger is stale by construction.** It was generated 2026-07-24 on branch
   `arena/019f958d` at `d467777d…`. Current HEAD is `b7b1dcf5`. A checksum mismatch already proves
   artifacts drifted. The ledger must be regenerated as one batch from a single commit.
3. **Dependency advisories regressed** after the Gate-0 checklist claimed B2 closed: a `critical`
   `proxy-addr` IP-spoofing advisory now exists, alongside Hono/fast-uri/MCP-SDK highs.
4. **CI does not match the pinned toolchain** (Node 20 in CI, `^22.x` in `engines`/`.nvmrc`/ADR-0031),
   so CI green would not be evidence for the supported line.
5. **Server suite is green on Windows but the SDK is not**, so the "full repository suite" is red
   for a single path-handling test — the cheapest and most embarrassing blocker we have.
6. **The claim-scan gate is silently bypassable in scripts** (`cmd | tail` masks its exit code).
   Any tracker task that runs it MUST capture `$?` directly.
7. **Lead measures in docs are inconsistent** (`sprint-status.yaml` lists advisories as blocking;
   Gate-0 checklist marks B2 closed). Both cannot be true; reconcile rather than pick one.
8. **No PostgreSQL, no Docker, no clean-machine runner here.** Every task requiring those is
   CI/Linux-blocked on this workstation and must be executed there.

---

## 1. Blocker scoreboard

| Blocker | Real state (2026-11-15) | Closing wave |
|---|---|---|
| **B1** full repository suite | ✅ root `pnpm -r test` exit 0 (262 server files, 2593 passing, 1 skipped) | W1 |
| **B2** dependency advisories | ✅ 0 open — audit exits 0 | W2 |
| **B3** migration rollback/restore | ✅ SQLite + live PostgreSQL green; PGlite forward-only; pgvector integration open | W3 |
| **B4** clean-machine golden path | runbook ✅; drill evidence 🔴 | W4 |
| **B5** security triage + independent review | matrix contested; reviewer unassigned | W5 |
| **T1** claim gate | 🔴 exit 1 (1 unresolved claim) | W0 |
| **T2** ledger reproducibility | 🔴 checksum mismatch | W0 |
| **T3** validator self-tests | 🔴 `pass-with-nonzero-exit` diagnostic missing | W0 |
| **T4** CI toolchain parity | 🟡 Node 20 vs ^22 | W0 |
| **T5** coverage + e2e enforcement | 🟡 configured, not gated | W4 |

---

## 2. Waves and milestones

```
W0 truth machine + hygiene ──┬─► W1 suite green ──┐
                             ├─► W2 deps clean ───┤
                             ├─► W3 migration drill┤─► Gate-0 exit ──► E10-S30 ──► RELEASE
                             ├─► W4 golden path ───┤
                             └─► W5 security ──────┘
W6 release mechanics (tag, smoke, retrospective) after M4 only.
```

| Milestone | Content | Exit proof |
|---|---|---|
| **M0** | W0 complete | claim scan 0, ledger validator 0, validator negative tests 0, CI Node 22 |
| **M1** | W1 + W2 | one retained `pnpm -r test` at exit 0; `pnpm audit --prod` clean or signed dispositions |
| **M2** | W3 + W4 | migration matrix ×3 engines; 14/14 golden-path steps |
| **M3** | W5 | triage matrix reviewed; reviewer named; Gate-0 five criteria evidenced |
| **M4** | E10-S30 | independent reviewer flips release decision |

---

## 3. Task register

Status: ⬜ todo · 🟡 in progress · 🔴 blocked · ✅ done · ⏸ deferred.

### W0 — Truth machine and repo hygiene (do first)

| ID | Task | Story | Deps | Acceptance (binary) | Evidence | Status |
|---|---|---|---|---|---|---|
| W0-01 | Commit the uncommitted Phase-1 fixes (`audit.ts`, `kernel.ts`, `llm.ts`, `operations-ext.ts`, `server/vitest.config.ts`, `brain.test.ts`, `setup-isolated-db.ts`, `sqlite-mcp-write-paths.test.ts`, `.gitignore`, sdk engines) | E10-S22 | — | `git status` clean; suite still 0 failed files | commit + suite log | 🟡 |
| W0-02 | Fix the SDK Windows path test (`r1-serena` absolute/relative) without weakening assertions | E10-S22 | W0-01 | `cd packages/sdk && npx vitest run` exit 0 on Windows **and** Linux | raw log both OSes | 🔴 |
| W0-03 | Resolve the 1 unresolved claim at `docs/bmad/security-triage-matrix-2026-08-24.md:19` by classifying it as historical/superseded with an explicit banner | E10-S1 | — | `scan-r1-documentation-claims.ts --check` exit 0; `unresolvedCurrentClaims=0` | raw log | 🔴 |
| W0-04 | Repair the validator negative-test regression (`pass-with-nonzero-exit` must emit "a pass record must have actual.exitCode = 0") | E10-S4 | — | `test-r1-release-evidence-validator.ts` exit 0, all 4 fixtures rejected for the right reason | raw log | 🔴 |
| W0-05 | Regenerate the evidence ledger from one commit: fresh full-suite + targeted + typecheck + lint logs, correct SHA-256s, current commit/branch | E10-S4 | W0-02 | `validate-r1-release-evidence.ts` exit 0; ledger `evidenceSource.repositoryCommit` = HEAD | ledger + artifacts | 🔴 |
| W0-06 | Make the ledger protocol append-only: a checker that fails if an artifact changes without a new ledger entry | E10-S4 | W0-05 | checker added + negative test proves drift is detected | test log | ⬜ |
| W0-07 | CI toolchain parity: Node `22` in `validate.yml` (and any other workflow), `pnpm install --frozen-lockfile` retained | WS0/E10-S22 | — | CI run green on Node 22; no Node 20 references | CI URL/log | 🔴 |
| W0-08 | Fail-fast audit of gate commands: no workflow/script pipes a gate into `tail`/`grep` without `pipefail` | E10-S1 | — | repo-wide grep clean; `set -o pipefail` present where needed | grep log | ⬜ |
| W0-09 | Reconcile `gate0-exit-checklist.md` with measured reality (B2 is **open**, not closed; criterion 5 pending) | E10-S2 | W0-05 | checklist contains only ledger-backed statuses | doc diff | 🔴 |
| W0-10 | Record the "no PostgreSQL/no Docker here" constraint in the plan and route B3/B4 to CI | E10-S2 | — | noted in tracker §6 and sprint status ATTESTATION | doc diff | ⬜ |

### W1 — B1: full repository suite green

| ID | Task | Story | Deps | Acceptance | Evidence | Status |
|---|---|---|---|---|---|---|
| W1-01 | Fix the SDK path test (same as W0-02; tracked once) | E10-S22 | — | see W0-02 | log | 🔴 |
| W1-02 | Make `pnpm -r test` usable as a gate: either `--no-bail` aggregation or per-package jobs in CI so one failure doesn't hide the rest | E10-S22 | — | root command reports every package's result in one run | CI log | ⬜ |
| W1-03 | Capture one full-workspace run on Linux/Node 22 and retain it | E10-S22 | W0-07 | exit 0, all packages, artifact in `evidence/` | log + sha256 | 🔴 |
| W1-04 | Verify the newly added `server/tests/**` (hub Phase 1/2) are inside the gate and stable across 3 consecutive runs | E10-S22 | W1-03 | 3× identical pass counts | 3 logs | 🟡 |
| W1-05 | Confirm the suite cannot silently shrink: compare test-file count to the previous gate | E10-S22 | W1-03 | count ≥ 262 server files; any drop explained | diff | ⬜ |

### W2 — B2: dependency advisories

| ID | Task | Story | Deps | Acceptance | Evidence | Status |
|---|---|---|---|---|---|---|
| W2-01 | Triage all 41 advisories into upgrade / override / accept-with-rationale | E10-S27 | — | every advisory has an owner + disposition | matrix | ✅ |
| W2-02 | Remediate the **critical** `proxy-addr` IP-spoofing advisory (upgrade or override) | E10-S27 | W2-01 | advisory absent from audit | audit log | ✅ |
| W2-03 | Remediate high advisories: `fast-uri` (2), Hono family, MCP TypeScript SDK (2), browserslist (2) | E10-S27 | W2-01 | highs absent or accepted with written rationale | audit log | ✅ |
| W2-04 | Re-run `pnpm audit --prod` and retain output | E10-S27 | W2-02, W2-03 | exit 0 **or** signed dispositions for every remainder | log + sha256 | ✅ |

Notes: pnpm 9 ignores `overrides:` in `pnpm-workspace.yaml`; the effective block is
`package.json` → `pnpm.overrides`. The zod 4.6.6 migration was required by the last high advisory
and is expressed as `z.record(z.string(), …)`, `.prefault({})` and zod 4's canonical error text.

### W3 — B3: migration matrix and rollback drill

| ID | Task | Story | Deps | Acceptance | Evidence | Status |
|---|---|---|---|---|---|---|
| W3-01 | Review the existing down scripts 0049–0054 for correctness (FK order, triggers, sqlite twins) | E10-S16 | — | review note per file, no TODO | review artifact | ✅ |
| W3-02 | Forward 0049→0054 then roll back 0054→0049 on **SQLite** (fresh DB) | E10-S17 | W3-01 | exit 0 both directions, schema diff empty vs baseline | per-step log | ✅ |
| W3-03 | Same matrix on **PGlite** | E10-S17 | W3-01 | exit 0 both directions | log | ✅ |
| W3-04 | Same matrix on **live PostgreSQL** (CI service) | E10-S17 | W3-01 | exit 0 both directions | CI log | 🔶 green locally on PostgreSQL 18.7; CI leg still required |
| W3-05 | Restore-from-backup + integrity verification after rollback on all three engines | E10-S17 | W3-02..04 | data round-trips, `audit_verify` passes | log | ✅ pg_dump/pg_restore sentinel round-trip on PostgreSQL; SQLite/PGlite covered by forward+rollback+reapply |
| W3-06 | Retain drill evidence and ledger entry | E10-S17 | W3-02..05 | validator green with new artifacts | ledger | ✅ |

Defects found and fixed by the drill: SQLite rollback used PostgreSQL-only
`ALTER TABLE … DROP COLUMN IF EXISTS`; and the 0049 down scripts dropped
`mode`/`scope`/`idempotency_key`, which the base application schema owns. Rollback now removes
only R1-owned tables and indexes.

### W4 — B4: golden path, frontend, e2e

| ID | Task | Story | Deps | Acceptance | Evidence | Status |
|---|---|---|---|---|---|---|
| W4-01 | Implement the real 14-step golden-path test from `GOLDEN-PATH-SPECIFICATION.md` (beyond `server/tests/e2e/system.e2e.test.ts`) | E10-S25 | W1, W3 | 14/14 steps, no data repair | test + log | 🔴 |
| W4-02 | Wire Playwright e2e into CI with a built frontend + server | WS8 | W4-01 | CI job runs and passes | CI log | 🔴 |
| W4-03 | Enforce coverage thresholds (80%) in CI, not just config | E10-S26 | — | CI fails below threshold | CI log | 🔴 |
| W4-04 | Execute the clean-machine drill on Windows + Linux per runbook | E10-S29 | W0-07, W4-01 | runbook steps pass on both OSes | transcripts | 🔴 |
| W4-05 | Ratify or implement Windows parity for `r1-sandbox-runner` (WS6 decision) | WS6 | — | decision recorded + degraded-mode copy surfaced, or Windows path implemented | ADR/doc + test | ⬜ |
| W4-06 | Reconcile the R1 dashboard state matrix (loading/empty/offline/degraded/permission) with PRD language | WS8 | — | checklist per screen, no placeholder views | review | ⬜ |

### W5 — B5: security triage, integrity stories, independent review

| ID | Task | Story | Deps | Acceptance | Evidence | Status |
|---|---|---|---|---|---|---|
| W5-01 | Update the security triage matrix with current findings (including SEC-04 retest) | E10-S28 | W2 | every finding: severity, owner, mitigation, retest | matrix | 🟡 |
| W5-02 | Scope every R1 SQL lookup/mutation by project (audit + regression tests) | E10-S12 | — | no unscoped query in R1 paths; negative tests | tests + review | ⬜ |
| W5-03 | Enforce principal→project authorization | E10-S13 | W5-02 | cross-project request returns 403 in tests | tests | ⬜ |
| W5-04 | Remove private runtime access in favour of typed service APIs | E10-S14 | W5-03 | no deep imports into runtime internals | review | ⬜ |
| W5-05 | Prove exactly-once crash recovery with a real effect | E10-S11 | W5-02 | crash at N checkpoints, zero duplicate effects | test log | ⬜ |
| W5-06 | Complete SQL compensation support | E10-S15 | W5-04 | compensation runs on failure; test | test log | ⬜ |
| W5-07 | Eliminate the last `: any` in R1 paths (`r1-evidence-timeline.ts`) | E10-S18 | — | grep returns 0; typecheck green | grep + tsc log | 🟡 |
| W5-08 | Validate every R1 API request/response contract | E10-S19 | W5-04 | contract tests per route | test log | ⬜ |
| W5-09 | Remove placeholders/simulations from claimed R1 paths | E10-S20 | W5-08 | grep clean in claimed paths; manual review note | review | 🟡 |
| W5-10 | Harden export/import/evidence integrity | E10-S21 | W5-08 | tamper tests fail closed | test log | ⬜ |
| W5-11 | Assign and onboard the **independent E10-S30 reviewer** (external to contributors) | E10-S30 | — | named reviewer + review schedule | ledger `reviewer.status` | 🔴 |
| W5-12 | Gate-0 criterion 2: story-by-story AC + evidence pointers for E10-S1…S5 | E10-S3 | W0-05 | each story links implementation + test + evidence | tracker/ledger | 🟡 |
| W5-13 | Gate-0 criterion 3: every full-suite failure has owner/disposition/rerun | E10-S5 | W1 | triage JSON matches current suite | triage artifact | 🟡 |
| W5-14 | Gate-0 criterion 5: ledger reproducible and independently confirmed | E10-S4 | W0-05, W5-11 | reviewer signs a reproduced ledger | signed artifact | 🔴 |

### W6 — Release mechanics (only after M4)

| ID | Task | Deps | Acceptance | Evidence | Status |
|---|---|---|---|---|---|
| W6-01 | Tag `v2.2.0-r1` from the reviewed commit | M4 | tag exists, points at signed ledger commit | tag | ⬜ |
| W6-02 | `deploy.yml` smoke on the tagged artifact | W6-01 | deploy smoke green | log | ⬜ |
| W6-03 | Publish retrospective (`bmad-bmm-retrospective`) | M4 | doc published | doc | ⬜ |
| W6-04 | Update README badge/claims to "released" only if reviewer flips | W6-01 | claim scan green | scan log | ⬜ |
| W6-05 | Open post-R1 track (deferred P2 stories, Rust strategy, honesty renames) | M4 | backlog items created | tracker | ⏸ |

### Workstream H — Agent Hub (user-requested, independent of R1 gate)

Committed already: `nexus connect` (12 agents, idempotent/backup/uninstall/dry-run), `nexus mcp-stdio`,
Claude Code hooks with fail-open + redaction, memory attribution, SQLite scope fix, 3 smoke scripts.

| ID | Task | Acceptance | Evidence | Status |
|---|---|---|---|---|
| H-01 | Derive a stable `projectId` from the git repo on capture | `captureSession` stores a project derived from `git rev-parse --show-toplevel`; test | test log | ⬜ |
| H-02 | Revoke the scoped principal on `nexus connect --uninstall` | uninstall disables `agent:<id>` key; test proves auth fails after | test log | ⬜ |
| H-03 | Hooks integration test with a real local server (recall injected, capture persisted) | end-to-end test, <500 ms recall | test log | 🟡 |
| H-04 | Postgres mode for `nexus connect` (mint + auth) | test on CI Postgres | CI log | ⬜ |
| H-05 | Document `nexus connect` in README/CHANGELOG (done in README; CHANGELOG pending) | docs match CLI `--help` | doc diff | 🟡 |
| H-06 | Verify `bin` entry works from an installed tarball (`npm pack` + global link) | `nexus list` runs from packed artifact | log | ⬜ |
| H-07 | Windows path correctness for all 12 agent targets | unit tests assert native separators | test log | ✅ |
| H-08 | Decide whether the hub ships in R1 or post-R1 (it is not in the R1 claim set) | decision recorded | doc | ⬜ |

---

## 4. Evidence protocol (every task)

1. Run the acceptance command with **exit status captured directly** (`cmd > log 2>&1; echo $?`),
   never through a pipe that masks it.
2. Retain the raw log under `docs/bmad/releases/evidence/` with a dated, descriptive name.
3. Record the commit SHA and environment (OS, Node, pnpm, DB engine).
4. Add the artifact to the ledger **in the same batch** that changes status.
5. Re-run `validate-r1-release-evidence.ts` and `scan-r1-documentation-claims.ts --check` after
   every batch; both must exit 0.
6. Never edit a historical artifact in place — supersede it with a new dated artifact.

## 5. Global definition of done

- [ ] `pnpm -r typecheck` exit 0 (all packages)
- [ ] `pnpm -r lint` exit 0
- [ ] `pnpm -r test` exit 0 on Linux/Node 22 **and** Windows/Node 22
- [ ] `pnpm -r build` exit 0
- [ ] claim scan exit 0, ledger validator exit 0, validator negative tests exit 0
- [x] `pnpm audit --prod` clean or every finding signed off
- [ ] migration matrix green on SQLite/PGlite/PostgreSQL
- [ ] 14/14 golden path with crash recovery
- [ ] security triage reviewed by the independent reviewer
- [ ] E10-S30 sign-off recorded in the ledger

## 6. Risks and hard constraints

| Risk | Impact | Mitigation |
|---|---|---|
| Docker engine unavailable (WSL2 absent) | container-based pgvector runs impossible here | use local PostgreSQL 18; run pgvector integration in CI |
| Local PostgreSQL lacks pgvector | full-schema integration suite cannot run locally | CI service with pgvector; migration matrix is vector-independent |
| Ledger drift while working | evidence invalidated silently | append-only checker (W0-06), batch regeneration (W0-05) |
| Test suite "green by deletion" | false gate pass | count test files per run (W1-05); review diffs |
| Windows-only fix breaks Linux | release on unsupported evidence | dual-OS suite gate (W1-03) |
| Dependency fixes mid-requalification | new regressions | one advisory per commit, suite rerun each time |
| Hub work mistaken for R1 scope | claim inflation | H-08 decision + keep hub out of release claims until ratified |

## 7. Decisions needed from the maintainer

1. **Windows R1 support:** implement parity or ratify POSIX-first (WS6). Blocks W4-05 wording.
2. **Hub in R1?** The `nexus connect` workstream is not in the R1 claim set (H-08).
3. **Reviewer identity** for E10-S30 (must be independent of all contributors).
4. **Frozen-file approvals** still pending: `schema-sqlite.ts` json modes, `env.ts` `PORT=0`,
   `cli.ts` SQLite support, `setup.ts` log path, `drizzle.config.sqlite.ts` path.
5. **Advisory exceptions:** which remaining advisories are accepted with rationale vs must-fix.

## 8. Progress log

| Date | Task | Result | Artifact |
|---|---|---|---|
| 2026-11-15 | Audit snapshot | server 262/262 ✅; SDK 1 fail 🔴; claim/ledger/validator 🔴; audit 41 advisories 🔴 | this document |
| 2026-11-15 | Tracker created | 58 tasks across W0–W6 + H | this document |
