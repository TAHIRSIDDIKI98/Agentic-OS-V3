# NEXUS 2.0 / Agentic OS V3 — Master Progression Plan (2026-08-21)

> **Status:** RATIFIED — Leader decision recorded 2026-08-24 (see §9 Ratification Record).
> Per the standing governance rule, only an independent
> **E10-S30** review may change the R1 release decision.
>
> **Verified against:** HEAD `a3c30f6` ("fix: requalify release gates and compatibility seams",
> 2026-07-26) — the current tip of `main`.
> **Produced:** 2026-08-21 by a fresh evidence-gathering pass (see §1 and Appendix B).
> **Supersedes:** nothing authoritatively; it *organizes* the open items already recorded in
> `docs/bmad/baseline-2026-07-24-gate0.md`, `docs/bmad/execution-roadmap-2026-07-22.md`, and
> `docs/bmad/releases/evidence/2026-07-24-release-evidence-ledger.json`, and adds new findings
> from 2026-08-21 verification.

---

## 0. Executive summary

The project is a well-specified vertical slice (**R1 — Governed Agent Workbench**) that finished
its implementation sprints (E0–E9, all 34 stories done) but is **blocked from release** by its own
requalification gate. The blocking work is not discovery — it is **enumerated, owned, and
dispositioned**: 98 failing test files with per-file owners and categories, five named release
blockers, and an evidence-ledger protocol that already defines what "done" means.

**The single most important fact of this audit:** between 2026-07-26 (last commit) and
2026-08-21 (this analysis) the project stalled for ~4 weeks mid-requalification. The highest-value
action is simply to **restart sprint-8 in the order this plan lays out**, beginning with the
bootstrap fix (WS0) — without which no contributor machine can even run the suite reproducibly.

Historical baseline snapshot (measured at HEAD `a3c30f6`, 2026-08-21; superseded where the current B1–B5 matrix below has newer evidence):

| Surface | State at HEAD `a3c30f6` | Verdict |
|---|---|---|
| Server typecheck (`tsc --noEmit --incremental false`) | **0 errors** (re-measured fresh 2026-08-21) | ✅ green |
| Full unit suite (authoritative Gate-0 Linux run) | 98 failing files / 159 failing tests → **63 open blockers**, 35 repaired-but-unconfirmed | 🔴 release blocker |
| SDK suite / server lint / targeted suites | Pass (retained ledger evidence) | ✅ positive-only |
| Production dependency audit | Historical baseline had high/moderate findings; current GitHub notice reports 73 default-branch alerts | 🔴 release blocker; re-audit required |
| Migration matrix 0049–0054 (forward/rollback/restore) | Verified on SQLite, better-sqlite3, PGlite and live PostgreSQL 16 in isolated drills | ✅ drill matrix passed; retained evidence |

| Clean-machine golden path (14 steps) | Never executed end-to-end | 🔴 release blocker |
| Security triage + independent review | Unassigned reviewer; triage matrix pending | 🔴 release blocker |
| Reproducible bootstrap on a new machine | **Broken on Node ≥23** (better-sqlite3@11 cannot build); no pnpm/cargo auto-provisioned | 🟠 new finding |
| Windows platform support for R1 sandbox | Hard-throws (`r1-sandbox-runner.ts:63`) | 🟠 needs decision |

---

## 1. How this plan was produced (method)

Everything below traces to a measurement or a retained artifact — no stale claims were trusted:

1. **Docs reconciliation** — read the BMAD artifact chain (`03-brief` → `04-prd` → epics →
   sprint-status → Gate-0 baseline → R1-release-gate → evidence ledger) plus legacy trackers
   (`PLAN_TRACKER.md`, `TASKBOARD.md`, `PERFECTION_METRICS.md`), all of which now carry
   E10-R1 supersession notices.
2. **Live verification at HEAD** (Windows 11, Node v26.7.0): clean `pnpm install` attempt,
   fresh typecheck gate, and a full `vitest run` — results in §2.2 and Appendix B.
3. **Failure→owner mapping** — every entry in the retained triage JSON
   (`2026-07-24-full-suite-triage.json`) mapped to fleet namespaces independently; the mapping
   matched the JSON's own `owner.accountable` field on **all 98 entries, zero divergences**
   (Appendix A).
4. **Honesty-debt scan** — marker regexes over 562 production files (§2.6).
5. **Surface audits** — dashboard wiring, packages, Rust workspace, Tauri shell, CI/CD, Docker.

---

## 2. Verified current state

### 2.1 Release position

Current authority (`docs/bmad/baseline-2026-07-24-gate0.md`,
`docs/bmad/releases/evidence/2026-07-24-release-evidence-ledger.json`):

| # | Release blocker | Current disposition |
|---|---|---|
| B1 | Full repository test suite green | Still blocked: PR CI run `42964819231` has failing workspace tests, E2E, Rust, and server tests. Server failures include R1 policy/control, sandbox timeout, and PostgreSQL contract assertions; resolve and rerun. |
| B2 | Production dependency advisories resolved | Re-opened: GitHub push notice reports 73 default-branch alerts (3 critical, 22 high, 42 moderate, 6 low), conflicting with older clean-audit evidence. Reconcile production scope and re-audit. |
| B3 | Migration set 0049–0054 forward/rollback/restore/integrity validated | ✅ Passed: SQLite 3.40.1 SQL, better-sqlite3 11.10.0 / SQLite 3.49.2, PGlite 0.5.4, and live PostgreSQL 16 all passed their isolated drills. PostgreSQL CI step succeeded in run `42964819231`, artifact `r1-postgres-migration-drill`; see the retained SQLite/PGlite transcripts in `docs/bmad/releases/evidence/`. |
| B4 | Clean-machine golden-path drill (incl. kill-worker recovery) | Not executed |
| B5 | Security-triage matrix + independent E10-S30 review | Reviewer unassigned; triage pending |

Delivery state (`sprint-status.yaml`): sprints 1–7 done (E0-S1…E9-S4, 34 stories);
sprint-8 = "r1-integrity-security-and-release-requalification" (E10-S1…S30, 180 pts):
**S1–S10 in progress, S11–S30 backlog.**

### 2.2 Live verification at HEAD (2026-08-21, Windows / Node 26.7.0)

| Check | Result |
|---|---|
| Fresh install (`pnpm@10 install`) | ❌ fails: no prebuilt better-sqlite3 for Node 26; source build dies on removed V8 APIs (`GetPrototype`, `GetIsolate`, `PropertyCallbackInfo::This`) |
| Install `--ignore-scripts` | ✅ completes; tsc/vitest usable |
| `pretypecheck` (build sdk+a2a-server) then server true-gate typecheck | ✅ **0 errors** |
| Full `vitest run` | 188/255 files pass · 1852/1945 tests pass · 67 files fail |
| Failure decomposition (this platform) | ~31 files fail collection on missing native binding (**environment**, not product); `r1-sandbox-runner` suite fails on explicit win32 throw (**platform gap**); remainder consistent with the Gate-0 open set |

Interpretation: HEAD is **compile-clean** and the failure inventory matches the retained Gate-0
baseline modulo environment noise. The Gate-0 Linux triage remains the authoritative repair
backlog; nothing observed today contradicts it.

### 2.3 Delivery surfaces

- Dashboard: 43 pages + 32 components; **R1 workbench routes exist** (`src/router.tsx` →
  `/r1/dashboard`, `/r1/tasks/*`, `/r1/approvals`, `/r1/memories`; components in `src/components/r1/`;
  client in `src/lib/r1-client.ts`). localStorage appears in 16 files — mostly legitimate offline
  cache/fallback, but `r1-project-id` persistence and auth-key storage need an explicit design call.
- Packages: sdk (45 src files), a2a-server (7), devtools (2) — build/test scripts present, no
  committed `dist/`, sdk is the only one with a README. Marker-clean.
- Rust: cargo workspace has exactly **7 members** (`core, config, provider-types, providers,
  tools, nexus-search, nexus-cli`). `crates/tools/src/builtin.rs` tools are stubs;
  `nexus-search` self-describes as a build-clean stub. Per ADR-0007 the whole layer remains
  runtime-decoupled from the TS app (dormant but CI-checked).
- Tauri: real Tauri v2 app (valid conf, sidecar-spawning `lib.rs` with port-file handshake,
  14 UI `.tsx` incl. 3 placeholder views).
- CI: 3 workflows. `ci.yml` runs lint/typecheck/test/build, Postgres-backed integration,
  cargo check/clippy/test, CODEOWNERS coverage gate, Playwright E2E, and the isolated PostgreSQL
  migration drill. `validate.yml` substantially overlaps it but has an independent TypeScript/Rust
  gate. `deploy.yml` publishes Dockerfile.standalone on tags. Root Vitest coverage remains limited
  to server tests; the Playwright specs exercise the dashboard/API on :1422.

### 2.4 Reproducibility findings (new, actionable)

1. **Node version is unpinned and currently fatal.** `engines: >=20` admits Node 26, where
   better-sqlite3@11 cannot compile and has no prebuilt. The ledger's validated environment was
   **Node 22.22.3 + pnpm 9.15 on Linux**. Nothing pins contributors to that.
2. **No `packageManager` field** → corepack/pnpm version drift; this machine had neither pnpm nor
   cargo installed and npm's newer script-policy gates add friction.
3. **Windows is not a supported R1 platform today** (sandbox runner throws) — fine if declared,
   silent trap if not.

### 2.5 Documentation drift register (fix in WS7)

| Doc | Claim | Reality |
|---|---|---|
| AGENTS.md | Cargo workspace "10 members" + standalone `nexus-cli` | **7 members**; installer/safety/cli/observability crates don't exist; `nexus-cli` IS a member |
| CLAUDE.md | React 19 + Vite 7; "Cargo workspace of 9 crates"; ts-rs binding generation | React **18.3** / Vite **5.4**; 7 crates; no ts-rs anywhere |
| Root reports (`PROGRESS_REPORT.md`, `PROJECT_ANALYSIS.md`, `PERFECTION_PROGRESS*.md`, etc.) | Campaign-era completion language | Superseded by E10 notices elsewhere; need banners or archival |
| TASKBOARD.md P2-05/P2-06 | Component/E2E tests "⏳" vs "done" claims elsewhere | E2E specs exist but are wired to no CI job |

### 2.6 Honesty-debt snapshot

147 marker lines across 562 production files; **zero FIXME/HACK/vaporware**; only 4 TODO lines
(2 false positives). Real leftovers worth a ticket each:

- `server/src/services/federated-node-discovery.ts:237` — peer signature literal `'placeholder'`.
- `crates/tools/src/builtin.rs` — all four builtin tools return `"[stub] would run…"`.
- `skill-compiler.ts:275` / `skill-template-engine.ts:340` — `'null /* requires-llm */'` outputs.
- `wasm-plugin-runtime.ts` — validation/receipt layer only; no WASM engine (README grades 🔬 Preview — keep honest grading).
- `src/pages/Sessions.tsx:8` — TODO: rate-limit recall endpoint before public exposure.
- Tauri placeholder views (AgentsView/MemoryView/SettingsView).

README honesty framing is good (in-progress badge, maturity legend). Keep it that way through R1.

---

## 3. Strategy: two tracks, one gate

**Track A — Requalify R1 (the only path to "released").** Drive the five blockers B1–B5 to
evidence, in dependency order, using the existing ledger protocol. No new features until R1 flips.

**Track B — Make the truth machine trustworthy (runs alongside).** Reproducible bootstrap,
CI hardening, platform-support decisions, docs coherence. Track B exists because three of the
five blockers (B1 confirmation, B4 drill, B2 re-audit) require *running* things reliably on a
clean machine — currently impossible on Node ≥23 and unproven anywhere else.

Non-negotiables inherited from project governance: exclusive agent namespaces; FROZEN-core
sign-off; regression sets may shrink but never grow; every claim lands in the evidence ledger;
E10-S30 remains the sole release authority.

---

## 4. Workstreams

Sizes: S ≤ 1 focused day · M = 1–3 days · L = multi-day (fleet rounds). "Owner" = accountable
fleet agent per the ownership model; others contribute via their own namespaces.

### WS0 — Reproducible bootstrap & toolchain pinning · Owner: Bastion · Size S · **DO FIRST**

Actions:
1. Add `packageManager: "pnpm@9.15.0"` (or adopt pnpm 10 deliberately repo-wide — pick one) +
   strict `engines.node` pinning the supported line (recommend `"^22.x"` to match the ledger env),
   plus `.nvmrc`; document Node-version policy in CONTRIBUTING.
2. Decide the better-sqlite3 path once: (a) pin Node 22 (zero code risk, recommended for R1) or
   (b) upgrade to better-sqlite3 v12 prebuilds (touches a native dep mid-requalification — defer
   post-R1). Record the decision as an ADR addendum.
3. Verify a cold clone → install → typecheck → targeted suites on Windows + Linux; capture both
   transcripts into the ledger (this directly feeds B4's "clean-machine" requirement).
4. Fix npm-policy friction discovered on modern npm (allowScripts entries in package.json rather
   than command-line flags).

Exit criteria: a fresh machine can go clone→green-targeted-tests following docs alone, on two OSes;
ledger entries exist.

### WS1 — Full-suite green (B1) · Owner: Quill coordinates; per-file owners execute · Size L

The authoritative backlog is Appendix A (63 open + 35 confirmed-fixed-awaiting-green). Order the
attack by owner concentration so parallel agents never collide:

| Wave | Owners | Open files | Notes |
|---|---|---|---|
| 1 | Forge (11) + Artisan (9) | 20 | Largest clusters; kernel/runtime + SDK-side stale-test debt (Artisan's mix is 5×stale-test — cheapest wins first) |
| 2 | Pulse (8) + Sentinel (6) + Mnemosyne (6) | 20 | Self-opt defects are concentrated product fixes; Sentinel fixes unblock security posture sign-off |
| 3 | Lethe (5) + Cerebrum (3) + Metron (4) + Atlas (3) + Helix (3) + Aegis (2) + DB/R1 boundary (1) + Quill (1) + Bastion (1) | 23 | Long tail; batch by category (S-category files = repair contract, D = fix product) |

Rules (binding, from Gate-0): each repair = reproduce → fix in owner namespace → exact-file rerun
→ retain log; category dispositions respected (S-files fix the test/mock contract through approved
evidence-preserving change; ENV-files must be rerun on the supported environment, not suppressed);
the suite may only shrink. Quill re-runs the full suite after each wave and appends the raw log +
triage diff to the ledger.

Exit criteria: one retained full-suite run with **0 failed files** on the supported environment;
every formerly-failing file has before/after evidence.

### WS2 — Dependency audit clean (B2) · Owners: Sentinel + Bastion · Size S

Triage the outstanding production advisories (upgrade / override / accept-with-rationale);
`pnpm-workspace.yaml` overrides pattern already exists (fast-uri, @hono/node-server). Re-run the
audit, attach output + dispositions to the ledger.

Exit criteria: `pnpm audit --prod` (or equivalent) exits clean, or every remaining finding has a
signed-off rationale in the ledger.

### WS3 — Migration matrix + rollback drill (B3) · Owners: DB/R1 boundary (@Warzonesiddiki delegate) + Forge · Size M

Execute E10-S16/S17: forward-migrate 0049→0054, roll back 0054→0049, restore-from-backup, integrity
verification on SQLite, PGlite, and live PostgreSQL (CI already provisions pgvector for
integration). The rollback chain exists. Disposable SQLite 3.40.1 SQL, better-sqlite3 runtime
(SQLite 3.49.2), and PGlite 0.5.4 legs passed; their transcripts are retained as
`2026-11-10-r1-sqlite-migration-drill.log`, `2026-11-10-r1-better-sqlite3-migration-drill.log`,
and `2026-11-10-r1-pglite-migration-drill.log`. The SQLite drill fixed `DROP COLUMN`
compatibility and preserved baseline project metadata. PGlite and live PostgreSQL use a
minimal pre-R1 projects-schema fixture isolated from `public`. The live PostgreSQL 16
forward/rollback/restore step also passed in CI run `42964819231`
(artifact `r1-postgres-migration-drill`); the enclosing server job later failed on unrelated
unit/integration assertions, which remain tracked under B1.

Exit criteria: SQLite, PGlite, and live PostgreSQL matrix green against supported baselines; rollback chain verified.

### WS4 — Clean-machine golden-path drill (B4) · Owners: Artisan + Prism · Size M (after WS0)

Run the documented 14-step golden path (init → capture → governed task → approval pause → execute
→ crash-injection recovery → evidence export/import dry-run) on a pristine machine/environment,
including the kill-worker-at-checkpoint recovery step. Screen-record or log everything; attach to
ledger. This is also the first real user-level validation of the R1 dashboard routes.

Exit criteria: 14/14 steps pass without data repair on the golden fixture; ledger entry with
artifacts.

### WS5 — Security triage + independent review assignment (B5) · Owners: Sentinel + Aegis; Leader assigns reviewer · Size M

1. Sentinel triages all E8-S1 adversarial findings into severity/severity-rationale matrix.
2. Close the small honesty items that are security-flavored (peer-signature placeholder,
   Sessions.tsx rate-limit TODO) or explicitly ticket them post-R1 with README note.
3. Leader assigns the **independent E10-S30 reviewer** now (external to all contributors) so they
   can watch evidence accumulate instead of reviewing a pile at the end.

Exit criteria: triage matrix in ledger; named reviewer acknowledged; review scheduled.

### WS6 — Platform-support decision · Owners: Forge + Bastion · Size S (decision) / M (if implementing)

Either implement Windows support in `r1-sandbox-runner.ts` (constrained-command execution parity)
or ratify "R1 is POSIX-first" and encode it: README support matrix, CI job labels, dashboard
degraded-mode copy when `process.platform === 'win32'` (the throw already exists — surface it
instead of crashing). Recommendation for R1: declare POSIX-first, implement Windows in post-R1.

Exit criteria: documented support matrix + graceful degradation implemented; ledger entry.

### WS7 — Docs coherence sweep · Owner: Lorekeeper · Size S

Execute §2.5 register: correct AGENTS.md/CLAUDE.md facts (crate count, React/Vite versions,
remove ts-rs claims), banner-or-archive campaign-era root reports, reconcile TASKBOARD P2-05/06
states, point "current reality" pointers at the Gate-0 baseline and this plan. Update
`PLAN_TRACKER.md` + `sprint-status.yaml` to reference WS structure once ratified.

Exit criteria: no doc contradicts disk or ledger; single "start here" chain documented.

### WS8 — Frontend completion + e2e wiring · Owners: Prism/Halcyon (UI), Quill/Bastion (gates) · Size M

1. Wire the existing Playwright specs into CI (needs built frontend + server; reuse the
   pgvector-service pattern from ci.yml) — currently zero e2e enforcement.
2. Decide localStorage items: `r1-project-id` + auth-key storage (move to proper storage or
   document as local-mode design), offline fallbacks stay.
3. Sweep dashboard UX states against PRD acceptance language (loading/empty/offline/degraded/
   permission) for the four `/r1/*` screens; replace the 3 placeholder Tauri views or mark them
   out-of-scope for R1 in docs.

Exit criteria: e2e green in CI; localStorage decisions recorded; r1 screens meet PRD state matrix.

---

## 5. Sequencing & milestones

```
WS0 (bootstrap) ──┬─► WS1 waves 1–3 (suite green) ─┐
                  ├─► WS2 (deps) ──────────────────┤
                  ├─► WS4 (golden path drill) ─────┼─► Gate-0 exit review ──► E10-S30 independent
                  └─► WS6 (platform decision)      │    (all B1–B5 evidence     sign-off ──► R1 RELEASE
WS3 (migrations) ─────────────────────────────────┤     assembled)                 flip (their call)
WS5 (security triage) ────────────────────────────┘
WS7 (docs) & WS8 (frontend/e2e) run continuously in parallel; WS8 must land before the drill
(WS4) exercises the dashboard.
```

| Milestone | Content | Maps to |
|---|---|---|
| **M0** | WS0 done; two clean-machine transcripts in ledger | enables everything |
| **M1** | WS1 waves 1–3 + WS2 done; full suite green; audit clean | B1, B2 |
| **M2** | WS3 + WS4 + WS6 done | B3, B4, platform matrix |
| **M3** | WS5 done; reviewer assigned; Gate-0 five exit criteria checked | Gate-0 closure |
| **M4** | E10-S30 independent review passes | **R1 release decision flips (reviewer's authority)** |

Gate-0 exit criteria cross-check (from the baseline doc): ① claims reference baseline/ledger ✓
(WS7) ② E10-S1..S5 stories+evidence ✓ (finish in-progress stories first) ③ every failure has
owner/disposition/rerun ✓ (WS1, Appendix A) ④ release doc carries no stale counts ✓ (WS7) ⑤
ledger reproducible & independently confirmed ✓ (WS5/M4).

Post-M4, immediately: tag `v2.2.0-r1`, run deploy.yml smoke, publish retrospective
(`bmad-bmm-retrospective`), then open the post-R1 track below.

---

## 6. Post-R1 preview (explicitly NOT started before M4)

Ordered by expected value:

1. **Deferred P2 stories**: MCP capability adapter (version-pinned), A2A task adapter,
   explicit one-project sync — already scoped in the release-gate table.
2. **Platform expansion**: Windows constrained-command runner (if deferred from WS6),
   better-sqlite3 v12 upgrade, Node 24/26 support line.
3. **Rust strategy decision point** (Leader + Ferric/Rusty): the dormant layer costs CI time and
   carries stub debt while delivering zero runtime value under ADR-0007. Either fund it to
   first real use (e.g., `nexus-cli` as a distribution vehicle) or freeze it behind a
   maintenance-only CI profile and say so honestly in docs.
4. **Honesty upgrades**: rename or regrade the theatrical modules (shadow-daemon, wasm-plugin-
   runtime, federated-recall) per the original P1-10 policy; implement or clearly label the
   federated signature path.
5. **Phases 21–30 roadmap refresh**: the master plan predates the R1 slice; re-baseline it
   against what R1 actually taught (Lorekeeper + Atlas).

---

## 7. Risks & mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Suite-green triggers new regressions during waves | Medium | Binding shrink-only rule; Quill full-suite rerun after each wave; per-wave triage diffs in ledger |
| Native-module churn breaks bootstrap again | Medium | WS0 pins Node line + documents rebuild recipe; revisit better-sqlite3 upgrade only post-R1 |
| Single reviewer bottleneck at E10-S30 | Medium | Assign reviewer in WS5 now; reviewer observes accumulating evidence rather than batch-reviewing |
| Scope creep ("just one more feature") during requalification | High | Track A discipline: non-goals list in PRD §3.2 is binding until M4; new ideas go to §6 backlog |
| Parallel agents colliding on shared fixtures/configs | Medium | Waves grouped by owner namespace (Appendix A ordering); FROZEN-core changes only via Leader sign-off |
| Docs drift misleads future contributors again | High | WS7 sweep + make PLAN_TRACKER the only status voice; archive campaign-era root reports |

---

## 8. Operating cadence (how the fleet consumes this plan)

Per owner, per round: pull your row from Appendix A (or your WS actions) → implement in your
namespace → local gate (`tsc --noEmit --incremental false` fresh + your area's tests) → PR titled
`<Agent>: WS<n> <artifact>` → Quill merge gate (full validate) → append evidence pointer to the
ledger entry you touched. Idle owners pick the smallest open S-category file in their row.
The loop repeats until M4; no status word may appear in any doc without a ledger pointer.

---

## Appendix A — Owner-by-owner failing-file roster (authoritative Gate-0 triage)

Legend: **D**=product defect · **ENV**=env/native · **BEH**=behavioral-after-native-build ·
**S**=stale/broken test contract. † = exact-file rerun already passed (`verified_fixed`;
still gated on a fully green suite). Paths relative to `server/tests/`.

| Owner | Files (open/total) | Category mix | File names |
|---|---|---|---|
| Forge | 11 / 19 | 13D·3ENV·1BEH·2S | bench-scheduler†· forge-live-seam · forge-selfheal · kernel-bootstrap† · kernel-introspect† · kernel-panic† · phase11-kernel · pipeline-executor† · preemption-leak-guard · resource-quota · ring-audit† · routes/kernel-introspect · scheduler-core · scheduler-phase11† · scheduler-property · scheduler-resilience-risk · services/kernel · services/scheduler-property† · sse-bridge |
| Sentinel | 6 / 13 | 10D·1ENV·1BEH·1S | crypto-audit† · guardrails-negative† · guardrails-quarantine† · killswitch-race · lib/auth-context† · memory-encryption† · phase14-security · rateLimit · secrets-scanner† · security† · security-lib-negative · security-mcp · sentinel-core |
| Mnemosyne | 6 / 12 | 4D·4ENV·2BEH·2S | federated-recall† · memory-analysis† · memory-attachments.store · memory-batch.apply · memory-cluster.ops · memory-perfection · memory-query† · memory-search-suggest† · memory-storage · memory-tag-taxonomy.async† · services/embeddings† · services/recall |
| Artisan | 9 / 10 | 2D·3BEH·5S | feedback.service · marketplace.service · marketplace† · plugin-manifest · project.service · services/feedback.service · services/session-recorder · services/skill-compiler-capability · services/skill-template-engine · services/wasm-capability-resolution |
| Pulse | 8 / 9 | 6D·1BEH·2S | gap-items · self-improvement-harness† · self-improvement-harness-control · self-opt · self-opt-adapters · self-opt-controller · self-opt-emit · self-opt-telemetry · self-opt-tuners |
| Lethe | 5 / 7 | 2D·1ENV·1BEH·3S | memory-backup · memory-cold-storage · memory-export-v3† · memory-forget · memory-lifecycle† · memory-priming · memory-stitcher |
| DB/R1 boundary (Leader) | 1 / 6 | 3D·2ENV·1BEH | db-concurrency · migration† · r1-application-postgres-contract† · r1-application-sqlite-contract† · r1-project-transfer-contract† · r1-routes† |
| Metron | 4 / 5 | 2D·3S | health · metron-caches · metron-probe-health · metron-tracing · overhead-accounting† |
| Cerebrum | 3 / 5 | 1D·1ENV·2BEH·1S | brain-v3 · llm-coalesce† · services/brain · services/llm-gateway-v2.pure · services/llm-gateway-v2† |
| Atlas | 3 / 3 | 2D·1BEH | a2a · routes/automation · services/agent-runtime |
| Quill | 1 / 3 | 2D·1ENV | e2e/system.e2e† · gate (eslint exit 2) · smoke-new-services† |
| Helix | 3 / 3 | 1D·2S | enterprise · enterprise-rbac · p2p-swarm |
| Aegis | 2 / 2 | 2D | fairness-corrector · services/audit-routes |
| Bastion | 1 / 1 | 1D | routes/v3-upgrade |
| **Totals** | **63 open / 98** | D51·ENV13·BEH13·S21 | (mapping matched triage `owner.accountable` on all 98, 0 divergences) |

No failing file maps to Prism, Halcyon, Ferric, Rusty, Tess, or Lorekeeper.

## Appendix B — Verification commands used (2026-08-21)

```bash
# Toolchain probe
node --version                     # v26.7.0 ; pnpm/cargo absent → installed ad hoc via npx
npx -y pnpm@10 install             # FAILS on better-sqlite3@11.10 vs Node 26 (V8 API removals)
npx -y pnpm@10 install --ignore-scripts   # OK; bins linked

# True typecheck gate (fresh)
cd server && npm run typecheck     # pretypecheck builds packages/a2a-server + packages/sdk
                                   # → tsc --noEmit --incremental false = 0 errors ✅

# Full unit suite (no DATABASE_URL)
cd server && npx vitest run        # 188/255 files · 1852/1945 tests pass; failures decompose per §2.2
```

Authoritative historical evidence referenced:
`docs/bmad/releases/evidence/2026-07-24-release-evidence-ledger.json` ·
`docs/bmad/releases/evidence/2026-07-24-full-suite-triage.json` ·
`docs/bmad/baseline-2026-07-24-gate0.md` · `docs/bmad/releases/R1-release-gate.md`.

---

*End of plan. Ratification checklist for the Leader: ☑ approve WS order · ☑ assign E10-S30
reviewer (WS5) · ☑ pick better-sqlite3/Node decision (WS0) · ☑ pick platform stance (WS6).*

---

## 9. Ratification Record (2026-08-24)

Recorded under explicit Leader delegation ("take the best decision for me"). This record does not
change the R1 release decision, which remains the exclusive authority of independent E10-S30 review.

| # | Decision point | Decision | Rationale |
|---|---|---|---|
| D1 | WS order / plan adoption | **Ratified as written** (WS0 → WS1 waves → WS2–WS8 → M0–M4). Plan is adopted as the master execution plan; Lorekeeper to mirror it into `PLAN_TRACKER.md` + `sprint-status.yaml`. | The plan is evidence-backed (Appendix A maps all 98 triaged files with zero owner divergences); re-deriving a competing plan adds no value and costs time. |
| D2 | E10-S30 reviewer | **External stateless audit agent**: fresh non-fleet agent session per evidence batch, which never edits code and writes only `docs/bmad/releases/evidence/reviews/<date>-*.md`. Named in sprint-status.yaml when the first batch lands. | E10-S30 requires independence from all contributors. A per-batch stateless agent preserves independence and avoids single-reviewer bottleneck (risk table §7). |
| D3 | better-sqlite3 / Node (WS0) | **Pin Node ^22.x (`engines` + `.nvmrc`) + `packageManager: pnpm@9.15.0`; keep better-sqlite3@11 for R1; defer v12 prebuilds post-R1.** | Zero code risk mid-requalification; matches ledger's validated environment (Node 22.22.3 / pnpm 9.15 / Linux). Native-dep upgrade deferred behind the release gate. |
| D4 | Platform stance (WS6) | **POSIX-first for R1; official Windows path = WSL2 (Ubuntu 22.04+).** Native win32 support is post-R1. Remaining WS6 work: replace the `r1-sandbox-runner.ts:63` hard throw with surfaced degraded-mode status + README support matrix. | Keeps R1 scope frozen; WSL2 gives Windows users (including the primary dev machine) a supported route without expanding the requalification surface. |
| D5 | External integration | **NEXUS connects to the DeepSeek Harness (DSH) via its existing MCP transport — config-level only, no bespoke plugin code pre-M4.** Post-R1 option: thin DSH client plugin for richer tool cards. NEXUS complements (does not replace) DSH built-in personal memory: DSH memory = personal/cross-project; NEXUS = project/team governed memory with audit trails. | NEXUS already ships a full MCP server (`server/src/mcp-http.ts`, 14 tools, scoped auth). MCP is the 2026 consensus protocol; a second custom integration surface would violate the Track A no-new-features rule and add maintenance debt before the first release. |
