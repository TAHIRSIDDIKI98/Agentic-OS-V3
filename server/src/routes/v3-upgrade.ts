/**
 * routes/v3-upgrade.ts — API routes for the 5 Pillars of the 100× upgrade.
 *
 * Each section exposes its service layer through REST endpoints with Zod
 * validation, envelope responses, and scope-gated auth.
 *
 * Pillar  I — Self-Improvement Harness
 * Pillar II — Plugin System (WASM runtime + manifest)
 * Pillar III — Federated Recall (privacy-preserving cross-instance memory)
 * Pillar IV  — Multi-Provider LLM Gateway v2
 * Pillar V   — DAG Pipeline Executor
 */
import { Hono } from "hono";
import { z } from "zod";
import type { NexusEnv } from "../lib/hono-env.js";
import { requireScope, safeJson, parse } from "../lib/auth-context.js";
import { ok, err } from "../lib/envelope.js";

/* ════════════════════════════════════════════════════════════════════════════
 * Pillar IV — Multi-Provider LLM Gateway v2
 * ════════════════════════════════════════════════════════════════════════════ */
import {
  listProviders, callLLMGateway, getBreakerSnapshot,
  setBudget, getBudget, killSession,
  type GatewayCall,
} from "../services/llm-gateway-v2.js";

export const v3upgrade = new Hono<NexusEnv>();

// ── LLM Gateway ──────────────────────────────────────────────────────────

v3upgrade.get("/api/v1/llm/providers", async (c) => {
  await requireScope(c, "llm:chat");
  const providers = listProviders().map((p) => ({
    name: p.name, models: p.models,
    capabilities: [...p.capabilities],
  }));
  return c.json(ok({ providers }, c.get("requestId") ?? ""));
});

v3upgrade.post("/api/v1/llm/chat", async (c) => {
  await requireScope(c, "llm:chat");
  const body = parse(z.object({
    sessionId: z.string().min(1),
    model: z.string().min(1),
    messages: z.array(z.object({
      role: z.enum(["system", "user", "assistant", "tool"]),
      content: z.string(),
      name: z.string().optional(),
      toolCallId: z.string().optional(),
    })).min(1),
    maxTokens: z.number().int().positive().optional(),
    temperature: z.number().min(0).max(2).optional(),
    stream: z.boolean().optional(),
    requires: z.array(z.enum(["vision", "tools", "1m_context", "json_mode"])).optional(),
    forceProvider: z.string().optional(),
  }), await safeJson(c));

  const call: GatewayCall = {
    sessionId: body.sessionId,
    policy: {
      preferred: ["m3", "anthropic", "openai", "google", "ollama", "vllm"],
      force: body.forceProvider,
      requires: body.requires,
    },
    request: {
      model: body.model,
      messages: body.messages.map((m) => ({
        role: m.role,
        content: m.content,
        name: m.name,
        toolCallId: m.toolCallId,
      })),
      maxTokens: body.maxTokens,
      temperature: body.temperature,
      stream: body.stream,
      requires: body.requires,
    },
  };

  const result = await callLLMGateway(call);
  return c.json(ok(result, c.get("requestId") ?? ""));
});

v3upgrade.get("/api/v1/llm/breakers", async (c) => {
  await requireScope(c, "llm:chat");
  const snapshot = await getBreakerSnapshot();
  return c.json(ok(snapshot, c.get("requestId") ?? ""));
});

v3upgrade.post("/api/v1/llm/budget", async (c) => {
  await requireScope(c, "llm:admin");
  const body = parse(z.object({
    sessionId: z.string().min(1),
    budget: z.number().int().positive(),
    expiresAt: z.string().optional(),
  }), await safeJson(c));
  await setBudget({
    sessionId: body.sessionId,
    budget: body.budget,
    expiresAt: body.expiresAt ? new Date(body.expiresAt) : undefined,
  });
  return c.json(ok({ set: true }, c.get("requestId") ?? ""));
});

v3upgrade.get("/api/v1/llm/budget/:sessionId", async (c) => {
  await requireScope(c, "llm:admin");
  const budget = await getBudget(c.req.param("sessionId"));
  if (!budget) return c.json(err("NOT_FOUND", "No budget found for session.", c.get("requestId") ?? ""), 404);
  return c.json(ok(budget, c.get("requestId") ?? ""));
});

v3upgrade.post("/api/v1/llm/budget/:sessionId/kill", async (c) => {
  await requireScope(c, "llm:admin");
  const body = parse(z.object({ reason: z.string() }), await safeJson(c));
  await killSession(c.req.param("sessionId"), body.reason);
  return c.json(ok({ killed: true }, c.get("requestId") ?? ""));
});

/* ════════════════════════════════════════════════════════════════════════════
 * Pillar I — Self-Improvement Harness (metrics + proposals)
 * ════════════════════════════════════════════════════════════════════════════ */
import {
  proposeImprovement, listProposals, getProposal,
  approveProposal, rejectProposal, applyPatch,
  measureAndFinalize, recordMetric, collectRecentMetrics,
  harnessTick,
  type ProposalInput, type ProposalStatus, type RiskClass,
} from "../services/self-improvement-harness.js";

// ── Self-Improvement ────────────────────────────────────────────────────

v3upgrade.get("/api/v1/improvement/proposals", async (c) => {
  await requireScope(c, "brain:admin");
  const filter = {
    status: (c.req.query("status") ?? undefined) as ProposalStatus | undefined,
    riskClass: (c.req.query("riskClass") ?? undefined) as RiskClass | undefined,
    limit: Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 50))),
  };
  const items = await listProposals(filter);
  return c.json(ok({ items, total: items.length }, c.get("requestId") ?? ""));
});

v3upgrade.post("/api/v1/improvement/proposals", async (c) => {
  await requireScope(c, "brain:admin");
  const body = parse(z.object({
    title: z.string().min(1).max(200),
    summary: z.string().min(1).max(2000),
    hypothesis: z.string().min(1).max(2000),
    targetMetric: z.string().min(1),
    baselineValue: z.number(),
    expectedDelta: z.number(),
    riskClass: z.enum(["ADVISORY", "BLOCKING", "SAFETY"]).default("ADVISORY"),
    patch: z.object({
      kind: z.enum(["env", "cache_ttl", "pool_size", "feature_flag"]),
      key: z.string().min(1),
      value: z.union([z.string(), z.number(), z.boolean()]),
    }),
    rationale: z.string().optional(),
  }), await safeJson(c));
  const proposal = await proposeImprovement(body as ProposalInput);
  return c.json(ok(proposal, c.get("requestId") ?? ""), 201);
});

v3upgrade.get("/api/v1/improvement/proposals/:id", async (c) => {
  await requireScope(c, "brain:admin");
  const proposal = await getProposal(c.req.param("id"));
  if (!proposal) return c.json(err("NOT_FOUND", "Proposal not found.", c.get("requestId") ?? ""), 404);
  return c.json(ok(proposal, c.get("requestId") ?? ""));
});

v3upgrade.post("/api/v1/improvement/proposals/:id/approve", async (c) => {
  const p = await requireScope(c, "brain:admin");
  const proposal = await approveProposal(c.req.param("id"), p.name);
  return c.json(ok(proposal, c.get("requestId") ?? ""));
});

v3upgrade.post("/api/v1/improvement/proposals/:id/reject", async (c) => {
  const p = await requireScope(c, "brain:admin");
  const body = parse(z.object({ reason: z.string() }), await safeJson(c));
  const proposal = await rejectProposal(c.req.param("id"), p.name, body.reason);
  return c.json(ok(proposal, c.get("requestId") ?? ""));
});

v3upgrade.post("/api/v1/improvement/proposals/:id/apply", async (c) => {
  await requireScope(c, "brain:admin");
  const result = await applyPatch(c.req.param("id"));
  return c.json(ok(result, c.get("requestId") ?? ""));
});

v3upgrade.post("/api/v1/improvement/proposals/:id/finalize", async (c) => {
  await requireScope(c, "brain:admin");
  const proposal = await measureAndFinalize(c.req.param("id"));
  return c.json(ok(proposal, c.get("requestId") ?? ""));
});

v3upgrade.post("/api/v1/improvement/metrics", async (c) => {
  await requireScope(c, "brain:admin");
  const body = parse(z.object({
    metric: z.string().min(1),
    value: z.number(),
    windowMs: z.number().int().positive().default(60_000),
    tags: z.record(z.string(), z.unknown()).default({}),
  }), await safeJson(c));
  await recordMetric(body.metric, body.value, body.windowMs, body.tags as Record<string, unknown>);
  return c.json(ok({ recorded: true }, c.get("requestId") ?? ""), 201);
});

v3upgrade.get("/api/v1/improvement/metrics/:name", async (c) => {
  await requireScope(c, "brain:admin");
  const limit = Math.min(200, Math.max(1, Number(c.req.query("limit") ?? 100)));
  const window = await collectRecentMetrics(c.req.param("name"), limit);
  return c.json(ok(window, c.get("requestId") ?? ""));
});

v3upgrade.post("/api/v1/improvement/tick", async (c) => {
  await requireScope(c, "brain:admin");
  const body = parse(z.object({
    metrics: z.array(z.string()).min(1),
    thresholds: z.record(z.string(), z.number()).optional(),
  }), await safeJson(c));
  const result = await harnessTick({
    metrics: body.metrics,
    thresholds: body.thresholds,
  });
  return c.json(ok(result, c.get("requestId") ?? ""));
});

/* ════════════════════════════════════════════════════════════════════════════
 * Pillar II — Plugin System
 * ════════════════════════════════════════════════════════════════════════════ */
import {
  registerPlugin, installPlugin, uninstallPlugin,
  loadPlugin, listInstalledPlugins, invokePlugin,
  listReceipts, revokePlugin,
} from "../services/wasm-plugin-runtime.js";
import { validateManifest, safeValidateManifest } from "../services/plugin-manifest.js";

// ── Plugin System ────────────────────────────────────────────────────────

v3upgrade.post("/api/v1/plugins/validate-manifest", async (c) => {
  await requireScope(c, "plugin:admin");
  const body = await safeJson(c);
  const result = safeValidateManifest(body);
  return c.json(ok(result, c.get("requestId") ?? ""));
});

v3upgrade.post("/api/v1/plugins", async (c) => {
  await requireScope(c, "plugin:admin");
  const body = parse(z.object({
    name: z.string().min(3).max(200),
    version: z.string().regex(/^\d+\.\d+\.\d+/),
    description: z.string().max(2000).optional(),
    authorPubkey: z.string().min(1),
    signature: z.string().min(1),
    wasmBase64: z.string().min(1),
    manifest: z.record(z.string(), z.unknown()),
    homepage: z.string().url().optional(),
    license: z.string().max(64).optional(),
    source: z.string().optional(),
  }), await safeJson(c));

  const manifest = validateManifest(body.manifest);
  const plugin = await registerPlugin({
    name: body.name,
    version: body.version,
    description: body.description,
    authorPubkey: body.authorPubkey,
    signature: body.signature,
    wasmBytes: Buffer.from(body.wasmBase64, "base64"),
    manifest,
    homepage: body.homepage,
    license: body.license,
    source: body.source,
  });
  return c.json(ok(plugin, c.get("requestId") ?? ""), 201);
});

v3upgrade.get("/api/v1/plugins", async (c) => {
  await requireScope(c, "plugin:admin");
  const items = await listInstalledPlugins();
  return c.json(ok({ items }, c.get("requestId") ?? ""));
});

v3upgrade.get("/api/v1/plugins/:id", async (c) => {
  await requireScope(c, "plugin:admin");
  const plugin = await loadPlugin(c.req.param("id"));
  if (!plugin) return c.json(err("NOT_FOUND", "Plugin not found.", c.get("requestId") ?? ""), 404);
  return c.json(ok(plugin, c.get("requestId") ?? ""));
});

v3upgrade.post("/api/v1/plugins/:id/install", async (c) => {
  await requireScope(c, "plugin:admin");
  const body = parse(z.object({
    ringOverride: z.number().int().min(0).max(3).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
  }), await safeJson(c));
  await installPlugin(c.req.param("id"), {
    ringOverride: body.ringOverride,
    config: body.config,
  });
  return c.json(ok({ installed: true }, c.get("requestId") ?? ""), 201);
});

v3upgrade.post("/api/v1/plugins/:id/uninstall", async (c) => {
  await requireScope(c, "plugin:admin");
  await uninstallPlugin(c.req.param("id"));
  return c.json(ok({ uninstalled: true }, c.get("requestId") ?? ""));
});

v3upgrade.post("/api/v1/plugins/:id/invoke", async (c) => {
  await requireScope(c, "plugin:invoke");
  const body = parse(z.object({
    agentId: z.string().min(1),
    capability: z.string().min(1),
    inputBase64: z.string().default(""),
  }), await safeJson(c));
  const inputBase64 = body.inputBase64 ?? "";
  const inputBytes = Buffer.from(inputBase64, "base64");
  const receipt = await invokePlugin({
    agentId: body.agentId,
    pluginId: c.req.param("id"),
    capability: body.capability,
    inputBytes,
    computeOutput: async () => ({
      outputBytes: Buffer.from("{}"),
      fuelUsed: 0,
      exitCode: 0,
    }),
  });
  return c.json(ok({
    receiptId: receipt.id,
    authorized: receipt.authorized,
    durationMs: receipt.durationMs,
    exitCode: receipt.exitCode,
    fuelUsed: receipt.fuelUsed,
  }, c.get("requestId") ?? ""), 201);
});

v3upgrade.post("/api/v1/plugins/:id/revoke", async (c) => {
  await requireScope(c, "plugin:admin");
  const body = parse(z.object({ reason: z.string().min(1) }), await safeJson(c));
  await revokePlugin(c.req.param("id"), body.reason);
  return c.json(ok({ revoked: true }, c.get("requestId") ?? ""));
});

v3upgrade.get("/api/v1/plugin-receipts", async (c) => {
  await requireScope(c, "audit:read");
  const items = await listReceipts({
    pluginId: c.req.query("pluginId") ?? undefined,
    limit: Math.min(200, Math.max(1, Number(c.req.query("limit") ?? 100))),
  });
  return c.json(ok({ items }, c.get("requestId") ?? ""));
});

/* ════════════════════════════════════════════════════════════════════════════
 * Pillar III — Federated Recall
 * ════════════════════════════════════════════════════════════════════════════ */
import {
  publishMemoryProof, ingestMemoryProof,
  listRecentProofs, federatedStats,
} from "../services/federated-recall.js";

// ── Federated Recall ─────────────────────────────────────────────────────

v3upgrade.post("/api/v1/federated/publish", async (c) => {
  await requireScope(c, "federated:write");
  const body = parse(z.object({
    peerId: z.string().min(1),
    publisherPrivKeyB64: z.string().min(1),
    contentSha256: z.string().min(1),
    embedding: z.array(z.number()),
    topicTags: z.array(z.string()).min(1),
    importance: z.number().min(0).max(1),
    privacyClass: z.enum(["public", "team", "private"]),
    ttlSeconds: z.number().int().positive().optional(),
  }), await safeJson(c));
  const proof = await publishMemoryProof(body);
  return c.json(ok(proof, c.get("requestId") ?? ""), 201);
});

v3upgrade.post("/api/v1/federated/ingest", async (c) => {
  await requireScope(c, "federated:write");
  const body = parse(z.object({
    origin_peer_id: z.string().min(1),
    origin_pubkey: z.string().min(1),
    signature: z.string().min(1),
    content_sha256: z.string().min(1),
    embedding: z.array(z.number()),
    topic_tags: z.array(z.string()).min(1),
    importance: z.number().min(0).max(1),
    privacy_class: z.enum(["public", "team", "private"]),
    ttl_seconds: z.number().int().positive().optional(),
  }), await safeJson(c));
  const result = await ingestMemoryProof(body);
  return c.json(ok(result, c.get("requestId") ?? ""));
});

v3upgrade.get("/api/v1/federated/proofs", async (c) => {
  await requireScope(c, "federated:read");
  const items = await listRecentProofs({
    materialized: c.req.query("materialized") === "true" ? true :
                  c.req.query("materialized") === "false" ? false : undefined,
    topic: c.req.query("topic") ?? undefined,
    limit: Math.min(200, Math.max(1, Number(c.req.query("limit") ?? 50))),
  });
  return c.json(ok({ items }, c.get("requestId") ?? ""));
});

v3upgrade.get("/api/v1/federated/stats", async (c) => {
  await requireScope(c, "federated:read");
  const stats = await federatedStats();
  return c.json(ok(stats, c.get("requestId") ?? ""));
});

/* ════════════════════════════════════════════════════════════════════════════
 * Pillar V — DAG Pipeline Executor
 * ════════════════════════════════════════════════════════════════════════════ */
import {
  savePipeline, runPipeline, validateDAG,
  listPipelines, listPipelineRuns,
  type NodeType, type PipelineNode, type PipelineEdge,
  type PipelineDAG,
} from "../services/pipeline-executor.js";

/**
 * Shared Zod schema for a DAG edge, used in both validate-dag and create.
 * Storing as a standalone schema avoids type-inference noise in the handler.
 */
const edgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  fromPort: z.string().optional(),
  toPort: z.string().optional(),
});

/**
 * Shared Zod schema for a DAG node, used in both validate-dag and create.
 */
const nodeSchema = z.object({
  id: z.string(),
  type: z.string(),
  position: z.object({ x: z.number(), y: z.number() }),
  config: z.record(z.string(), z.unknown()),
});

/**
 * Helper to cast a node's type field to NodeType for the pipeline service.
 */
function asNodeType(type: string): NodeType {
  return type as NodeType;
}

// ── Pipeline Executor ────────────────────────────────────────────────────

v3upgrade.post("/api/v1/pipelines/validate-dag", async (c) => {
  await requireScope(c, "pipeline:admin");
  const body = parse(z.object({
    nodes: z.array(nodeSchema).min(1),
    edges: z.array(edgeSchema).default([]),
  }), await safeJson(c));
  const dagNodes = body.nodes.map((n) => ({ ...n, type: asNodeType(n.type) } as PipelineNode));
  const dagEdges = (body.edges ?? []).map((e) => ({ from: e.from, to: e.to, fromPort: e.fromPort, toPort: e.toPort } as PipelineEdge));
  const dag: PipelineDAG = { nodes: dagNodes, edges: dagEdges };
  const result = validateDAG(dag);
  return c.json(ok(result, c.get("requestId") ?? ""));
});

v3upgrade.post("/api/v1/pipelines", async (c) => {
  const p = await requireScope(c, "pipeline:admin");
  const body = parse(z.object({
    name: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
    nodes: z.array(nodeSchema).min(1),
    edges: z.array(edgeSchema).default([]),
    trigger: z.record(z.string(), z.unknown()).optional(),
  }), await safeJson(c));
  const dagNodes = body.nodes.map((n) => ({ ...n, type: asNodeType(n.type) } as PipelineNode));
  const dagEdges = (body.edges ?? []).map((e) => ({ from: e.from, to: e.to, fromPort: e.fromPort, toPort: e.toPort } as PipelineEdge));
  const dag: PipelineDAG = { nodes: dagNodes, edges: dagEdges };
  const pipelineId = await savePipeline({
    name: body.name,
    description: body.description,
    dag,
    trigger: body.trigger,
    author: p.name,
  });
  return c.json(ok({ id: pipelineId }, c.get("requestId") ?? ""), 201);
});

v3upgrade.get("/api/v1/pipelines", async (c) => {
  await requireScope(c, "pipeline:admin");
  const items = await listPipelines();
  return c.json(ok({ items, names: items.map((p: { name: string }) => p.name) }, c.get("requestId") ?? ""));
});

v3upgrade.get("/api/v1/pipelines/:name", async (c) => {
  await requireScope(c, "pipeline:admin");
  const { getPipelineByName } = await import("../services/pipeline-executor.js");
  const pipeline = await getPipelineByName(c.req.param("name"));
  if (!pipeline) {
    return c.json(ok(null, c.get("requestId") ?? ""), 404);
  }
  return c.json(ok(pipeline, c.get("requestId") ?? ""));
});

v3upgrade.post("/api/v1/pipelines/:id/run", async (c) => {
  const p = await requireScope(c, "pipeline:execute");
  const body = parse(z.object({
    inputs: z.record(z.string(), z.unknown()).optional(),
  }), await safeJson(c));
  const result = await runPipeline({
    pipelineId: c.req.param("id"),
    triggeredBy: p.name,
    inputs: body.inputs,
  });
  return c.json(ok(result, c.get("requestId") ?? ""), 201);
});

v3upgrade.get("/api/v1/pipelines/:id/runs", async (c) => {
  await requireScope(c, "pipeline:admin");
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 50)));
  const runs = await listPipelineRuns(c.req.param("id"), limit);
  return c.json(ok({ runs }, c.get("requestId") ?? ""));
});
