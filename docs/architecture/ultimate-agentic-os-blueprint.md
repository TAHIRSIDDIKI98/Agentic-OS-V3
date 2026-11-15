# Ultimate Agentic OS — Architecture Blueprint (2026-11-15)

Status: **living document**. Grounded in the code that exists in this repository, not aspiration.
Owner: Leader / architecture. Implementation ownership follows `AGENTS.md` namespaces.

This document maps the five-layer "ultimate agentic OS" model onto NEXUS 2.0 / Agentic OS V3:
what is already real, what is partial, and the order in which the gaps should close. The
binding constraint we optimize for is **agent context**, because every other layer is only as
useful as the agent's ability to remember what it learned and act on it in the next session.

## The five layers

| #   | Layer                          | Reference systems                   | NEXUS status                                                                                         |
| --- | ------------------------------ | ----------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 1   | Kernel & scheduler             | AIOS kernel, SUSE agentic framework | **Real** — ring kernel, MLFQ/EDF/FairShare scheduler, task worker                                    |
| 2   | Sandboxed execution            | CUA, Open Interpreter               | **Partial** — governed tool gateway + effect receipts; no container isolation or filesystem rollback |
| 3   | Universal tool bus             | SUSE MCP, ServiceNow agent fabric   | **Real** — MCP server + HTTP transport, A2A adapter, connectors                                      |
| 4   | Tiered persistent memory       | Hermes, LangGraph                   | **Strong, newly unified** — working/episodic/semantic stores; bounded context pack added 2026-11-15  |
| 5   | Governance & human-in-the-loop | ServiceNow AI Control Tower         | **Real** — scoped keys, approvals, kill switch, hash-chained audit                                   |

## Layer 1 — Kernel & scheduler

**Exists.** `server/src/services/kernel.ts` implements a ring model (0–4) with cgroups, POSIX-style
ACL, audit chaining and gang scheduling. `scheduler.ts` ships MLFQ (Q0–Q4 with starvation
promotion), EDF and FairShare, swappable at runtime. `task-worker.ts` polls, admits through the
kernel gate and dispatches. Admission and preemption are covered by server tests.

**AIOS-inspired gap.** AIOS treats _LLM calls themselves_ as the scheduled resource with explicit
token budgets. NEXUS has `llm-scheduler.ts` and `NEXUS_LLM_MAX_CONNS`, but admission is not
token-budget-aware: a task cannot declare "this task may spend N tokens of model context", and
parallel sub-agents have no per-project token quota that the scheduler enforces.

**Next increment.** Add `contextBudget` to task admission: scheduler refuses or queues a task whose
declared context budget exceeds the project's remaining allowance, and records the decision in the
task event stream. This is the AIOS idea with NEXUS governance semantics.

## Layer 2 — Sandboxed execution

**Exists.** `BoundedToolGateway` gates every tool call by capability, scope and approval, and writes
effect receipts; `effectClaims` makes effects single-shot and idempotent. `sandbox.ts` and
`sandbox-worker.ts` run work in a child process, and `wasm-plugin-runtime.ts` isolates plugins.
The Windows desktop actuator is a separate, explicitly-gated surface.

**Gap.** There is no _container_ isolation: Docker's Linux engine needs WSL2, which this machine
does not have, so the local guarantee is process-level, not kernel-level. There is also no
filesystem snapshot / instant rollback primitive — approvals prevent bad effects, but a permitted
write cannot be undone as a unit.

**Next increment (local-first).** Implement rollback as a **git-worktree snapshot**: before a
write-capable task, record the worktree HEAD and a stash-style snapshot; on failure or operator
request, restore the snapshot inside the project root and emit a compensating receipt. This gives
the Open Interpreter "instant rollback" property without a container runtime, and is testable on
this machine today. Container isolation stays a POSIX/CI concern (ADR-0031).

## Layer 3 — Universal tool bus

**Exists.** `mcp.ts` exposes the governed MCP tool surface (recall, remember, capture, feedback,
audit verification, stats, delegation, agents, scheduler, cron, ambient ingest, ACL checks, and now
`nexus_context_pack`). `mcp-http.ts` serves it over HTTP. `packages/a2a-server` provides the
agent-to-agent protocol, and `mcp-registry.ts` documents the surface.

**Gap.** Two things separate this from SUSE-style ubiquity: (a) no first-class _external_ connector
catalog with per-connector credential scoping beyond the existing connectors directory, and (b) no
"agent fabric" that lets an internal agent discover, negotiate with and call a third-party agent
under the same approval/audit semantics as a local tool.

**Next increment.** Route external A2A calls through `BoundedToolGateway` so a remote agent is just
another capability with a scope, an approval policy and a receipt. Discovery metadata should come
from a signed registry entry, never from the remote peer's self-description.

## Layer 4 — Tiered persistent memory (the binding constraint)

**Exists, and is the strongest layer.** Three tiers are real:

- **Working** — task state, task events, approvals, effect receipts (R1 extended runtime).
- **Episodic** — session capture (`captureSession`, `ingestAmbientTranscript`), audit chain,
  evidence timeline with decided approvals retained.
- **Semantic** — provenance-bearing memories with lifecycle (`active`/`candidate`/`archived`/
  `forgotten`), evidence citations, contradiction and dedup services, consolidation and decay.

**Added 2026-11-15 — bounded context packs.** `packages/sdk/src/r1-context-pack.ts` composes the
three tiers into one deterministic digest: project identity, open tasks, pending approvals and
ranked active memories, packed to a caller-supplied token budget using the recall estimator. It
never exceeds the budget, excludes archived/forgotten memories and terminal tasks, ranks approvals
above passive context, honours a `focus` query, reports per-section omissions, and returns evidence
citations. Exposed at `GET /api/v1/r1/projects/:projectId/context` and as the MCP tool
`nexus_context_pack`, so any agent can pull it at session start.

Verified: 6 SDK tests (budget, lifecycle filtering, focus ranking, truncation, durable approvals,
error cases) and 3 route tests (200 pack with citations, 400 invalid budget, 404 unknown project).
SDK typecheck, server typecheck, lint and 73 MCP/security/route tests pass.

**Gap — the learning loop is manual.** A context pack is only as good as the memories it packs.
Today, turning a completed session into durable semantic memory requires an explicit capture call,
and the consolidation/dedup/contradiction services are not chained into a single post-task
pipeline. That is precisely the "gets smarter as we work" property.

**Next increment — session → memory → next pack.** On task completion, run one governed
consolidation pass: extract candidate facts and decisions from the task's events and transcript,
attach provenance (agent, evidence, confidence), dedupe against existing memories, flag
contradictions for review, and write only `active` memories that pass the confidence threshold.
Then assert the next context pack contains them. That closed loop is the product.

**Second gap — pack quality signals.** Recall has feedback weighting; context packs do not yet learn
which sections an agent actually used. Record pack usage (which item IDs appeared in a subsequent
tool call or decision) and feed it back into ranking. Without this, ranking stays heuristic.

## Layer 5 — Governance & human-in-the-loop

**Exists.** Scoped API keys (9 scopes) with scrypt hashing and constant-time comparison; approval
gates that block writes pre-effect (proven by the golden-path test); HTTP 423 kill switch;
hash-chained append-only audit with a verifier; rate limits; guardrails; DLP and secret scanning;
geofencing and time gates.

**ServiceNow-inspired gap.** There is no single "control tower" view that answers, in one place:
what is running, what is waiting for me, what changed in the last hour, and what is one click from
being stopped. The dashboard has the pieces but not the consolidated operator surface.

**Next increment.** A read-only control-tower endpoint that aggregates: active tasks by state,
pending approvals with age, recent denied tool calls, kill-switch state, audit-chain verification
status, and context-pack budget consumption per project. The dashboard renders it; nothing in it
can mutate state, so it is safe to expose broadly and auditable by construction.

## Build order (why this order)

1. **Session → memory → pack** (layer 4). Directly attacks the context limit; uses only existing
   services; testable offline; highest value per unit of risk.
2. **Pack usage feedback** (layer 4). Makes ranking improve with real work rather than guesses.
3. **Context-budget admission** (layer 1). Prevents parallel sub-agents from exhausting context
   before the loop above can help them.
4. **Git-worktree rollback** (layer 2). Gives permitted-but-wrong writes a compensating path.
5. **Control tower aggregation** (layer 5). Operator trust at 24×7 scale.
6. **Remote agents as governed capabilities** (layer 3). Only after local semantics are proven.

## Explicit non-goals for now

- A general GUI-driving agent (screen parsing + action synthesis). The desktop actuator is a
  governed primitive, not a computer-use agent; building one is a separate, large programme.
- Container orchestration on this machine while WSL2 is unavailable.
- Agent-to-agent payments / "agent economy". Discovery and negotiation come first; money is a
  governance problem, not a routing problem.

## How to verify this document

- Layer claims map to files listed inline; run `pnpm -r typecheck`, `pnpm -r lint`, and the cited
  test files rather than trusting prose.
- The R1 release gate remains the authority on ship-readiness: `docs/bmad/sprint-status.yaml` and
  the release evidence ledger. This blueprint does not change that decision.
- Known environmental limits: Docker/WSL2 absent (no container isolation locally), local PostgreSQL
  18 lacks pgvector (vector path validated in CI only), independent E10-S30 review unassigned.
