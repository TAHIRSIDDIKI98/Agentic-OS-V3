# E10-R1 Security Triage Matrix — 2026-08-24

**Authority:** WS5 of the ratified progression plan (`docs/bmad/progression-plan-2026-08-21.md` §4).
**Input findings:** Correct-Course proposal `_bmad-output/planning-artifacts/sprint-change-proposal-2026-07-24.md` §1 (adversarial audit), progression-plan §2.6 honesty-debt scan, 2026-08-24 `pnpm audit --prod`.
**Reviewer:** independent stateless E10-S30 audit agent per decision D2 (reviews this matrix + evidence at Gate-0 exit; writes to `docs/bmad/releases/evidence/reviews/`).
**Rule:** a row may say REMEDIATED only with a pointer to concrete evidence on disk. Everything else stays open.

| ID | Finding (source) | Severity | Exploitability | Owner | Status | Evidence / required retest |
|---|---|---|---|---|---|---|
| SEC-01 | Simulated constrained command runner returned fake results instead of executing (CC §1.1) | **Critical** | High — governed execution was theater | Forge/Bastion | ✅ REMEDIATED | Real spawn-without-shell runner `server/src/services/r1-sandbox-runner.ts`; adversarial suite `server/tests/r1-sandbox-runner.test.ts` **16/16 green** (PATH-hijack, symlink traversal, env-leak, timeout kill, output flood); hardened further in `010cf63` |
| SEC-02 | `isStepAlreadyExecuted` returned `false` via explicit placeholder — no duplicate-effect protection (CC §1.2) | **Critical** | High — replayed side effects | Atlas/SDK | ✅ REMEDIATED | Real implementation `packages/sdk/src/r1-task-worker.ts:272`; correlation-scoped contract asserted in `packages/sdk/src/r1-task-worker.test.ts:31-33`; crash-exactly-once proof remains gated on B4 drill (WS4) |
| SEC-03 | SQL approvals/contradictions lookups not constrained by `project_id` (CC §1.3) | **High** | Medium — cross-project reads possible in shared mode | DB/R1 boundary | ✅ REMEDIATED (verified 2026-08-24) | Rerun evidence: `r1-application-sqlite-contract`, `r1-project-transfer-contract`, `r1-effect-claims-contract` — **3 files / 9 tests green**, incl. cross-project denial, poisoned-import rollback, and PG round-trip with tampering rejection |
| SEC-04 | `routes/r1-extended.ts` checkpoint behavior via private `any` casts + placeholder fallback (CC §1.4) | Moderate | Low-Medium — typed-boundary violation, fail-open fallback | Aeon/Bastion | ⏳ PENDING VERIFICATION | Verify casts removed and fallback fails closed; belongs to E10-S18/S19 sweep |
| SEC-05 | Compensation discovery via private-map inspection; returns empty list for SQL (CC §1.5) | Moderate | Medium — rollback paths silently no-op for SQL repos | Atlas/DB | ✅ REMEDIATED (verified 2026-08-24) | Commit `9b04463` + rerun evidence: `r1-effect-claims-contract` and `r1-project-transfer-contract` suites green (claim/replay + restore paths exercised on both engines) |
| SEC-06 | Extensive explicit `any` in R1 client/components contrary to stated prohibition (CC §1.6) | Moderate | Low — type-safety erosion, not directly exploitable | Prism/Aeon | 🔴 OPEN | E10-S18 elimination pass post-wave; tracked as part of WS8 UI work |
| SEC-07 | No R1 component/E2E golden-path coverage (CC §1.7) | Moderate | Medium — unproven UX guarantees | Quill/Prism | 🔴 OPEN → WS8 | Specs authored (`e2e/*.spec.ts`) but wired to no CI job; enforcement lands with WS8 before WS4 drill |
| SEC-08 | Release gate incomplete: clean-machine drill, rollback plan, down migrations absent (CC §1.8) | **High** | n/a — operational risk | DB/R1 boundary + Artisan | 🔴 OPEN → WS3/WS4 | Migrations 0049–0054 are forward-only pairs; entire rollback dimension must be authored + drilled |
| SEC-09 | Production dependency advisories incl. high `fast-uri@3.1.3` (CC §1.9; re-audited 2026-08-24) | **High** | Medium — SSRF/host-confusion surface | Bastion/Sentinel | 🔶 FIXES DECLARED, VERIFICATION PENDING | `ab38fb7`: hono ^4.12.34, fast-uri ^3.1.5 override, ip-address ^10.3.1 override; clean re-audit required after lockfile regen |
| SEC-10 | BMAD scores/status documents conflict across reports (three divergent totals) (CC §1.10) | Moderate | n/a — governance trust | Lorekeeper | ✅ REMEDIATED | WS7 passes 1–2 (`b82aa6f`, `899769c`): primary guidance corrected; 14 campaign reports bannered superseded; single authority = Gate-0 baseline + ratified plan |
| SEC-11 | Federated peer signature literal `'placeholder'` (`federated-node-discovery.ts:237`, "Would be Ed25519") | Moderate | **Unreachable** — repo-wide grep shows zero importers of the module; not instantiated by any route/service | Helix/Mnemosyne | 🔶 MITIGATED-BY-DISCONNECT | Module is unwired in R1 (verified 2026-08-24). Standing rule: wiring it REQUIRES Ed25519 peer signing first (post-R1 item); until then any PR importing this module fails review |
| SEC-12 | `Sessions.tsx:8` TODO — rate-limit recall endpoint before public exposure | Low-Medium | Covered — `app.ts:87` applies global `rateLimit` middleware (`app.use('*')`) to every `/api/v1/*` route incl. `/recall`; configurable via `NEXUS_RATE_LIMIT_PER_MINUTE` | Prism/Sentinel | ✅ REMEDIATED (already enforced at app level) | Evidence: server/src/app.ts:87, proxy.ts rateLimit implementation; TODO comment in Sessions.tsx is stale relative to app-level control — cleanup rides with WS8 UI pass |

## Disposition summary

- ✅ Remediated with evidence: SEC-01, SEC-02, SEC-03, SEC-05, SEC-10, SEC-12
- 🔶 Declared, awaiting verification run: SEC-09
- 🔶 Mitigated by disconnect (unwired module; wiring requires Ed25519 signing first): SEC-11
- ⏳ Claimed-fixed upstream, verification owed: SEC-04 (converts at the next full-suite rerun)
- 🔴 Open, scheduled: SEC-06/07 (→ WS8), SEC-08 (→ WS3/WS4)

Gate-0 exit requires: every ⏳ row converted to ✅/🔴 with rerun evidence; then E10-S30 independent review of this matrix + ledger.
