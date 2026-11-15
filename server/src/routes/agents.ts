/**
 * routes/agents.ts — Multi-Agent Kernel, task queue, worker, cron, HITL approvals, ambient ingestion.
 */
import { Hono } from "hono";
import type { NexusEnv } from "../lib/hono-env.js";
import { requireScope, safeJson, parse } from "../lib/auth-context.js";
import { z } from "zod";
import { spawnAgent, listAgents, getAgent, updateAgentState, quarantineAgent, enqueueTask, pickNextTask, completeTask, failTask, schedulerStatus } from "../services/kernel.js";
import { createCronJob, listCronJobs, toggleCronJob, tickCron, ingestAmbientTranscript } from "../services/operations-ext.js";
import { broadcastSSE } from "../services/sse-bus.js";
import { ok, err } from "../lib/envelope.js";

export const agents = new Hono<NexusEnv>();

agents.get("/api/v1/agents", async (c) => {
  await requireScope(c, "memory:read");
  const items = await listAgents({ status: c.req.query("status") ?? undefined });
  return c.json(ok({ items }, c.get("requestId") ?? ""));
});

agents.post("/api/v1/agents", async (c) => {
  const p = await requireScope(c, "brain:admin");
  const body = parse(z.object({
    name: z.string().min(1).max(80), kind: z.enum(["sub-agent", "daemon"]).default("sub-agent"),
    parentId: z.string().optional(), ring: z.number().int().min(0).max(4).default(2),
    scopes: z.array(z.string()).default([]), llmModel: z.string().optional(),
    tokenBudget: z.number().int().default(100000), timeoutMs: z.number().int().default(120000),
  }), await safeJson(c));
  const agent = await spawnAgent(body, p.id);
  broadcastSSE({ type: "agent.state", data: agent, timestamp: Date.now() });
  return c.json(ok(agent, c.get("requestId") ?? ""), 201);
});

agents.get("/api/v1/agents/:id", async (c) => {
  await requireScope(c, "memory:read");
  const agent = await getAgent(c.req.param("id"));
  if (!agent) return c.json(err("NOT_FOUND", "Agent not found.", c.get("requestId") ?? ""), 404);
  return c.json(ok(agent, c.get("requestId") ?? ""));
});

agents.patch("/api/v1/agents/:id/state", async (c) => {
  await requireScope(c, "brain:admin");
  const body = parse(z.object({ status: z.string(), currentTool: z.string().optional() }), await safeJson(c));
  const updated = await updateAgentState(c.req.param("id"), body.status, body.currentTool);
  broadcastSSE({ type: "agent.state", data: updated, timestamp: Date.now() });
  return c.json(ok(updated, c.get("requestId") ?? ""));
});

agents.post("/api/v1/agents/:id/quarantine", async (c) => {
  const p = await requireScope(c, "brain:admin");
  const body = parse(z.object({ reason: z.string() }), await safeJson(c));
  await quarantineAgent(c.req.param("id"), body.reason, p.id);
  broadcastSSE({ type: "agent.state", data: { id: c.req.param("id"), status: "quarantined" }, timestamp: Date.now() });
  return c.json(ok({ quarantined: true }, c.get("requestId") ?? ""));
});

agents.get("/api/v1/bus/status", async (c) => {
  await requireScope(c, "memory:read");
  return c.json(ok({ clientCount: 0 }, c.get("requestId") ?? ""));
});

agents.get("/api/v1/scheduler/status", async (c) => {
  await requireScope(c, "memory:read");
  return c.json(ok(await schedulerStatus(), c.get("requestId") ?? ""));
});

agents.post("/api/v1/scheduler/tick", async (c) => {
  await requireScope(c, "brain:admin");
  return c.json(ok({ picked: await pickNextTask() }, c.get("requestId") ?? ""));
});

agents.post("/api/v1/tasks", async (c) => {
  const p = await requireScope(c, "memory:write");
  const body = parse(z.object({
    agentId: z.string().min(1), label: z.string().min(1), kind: z.string().default("interactive"),
    input: z.unknown().optional(), idempotencyKey: z.string().optional(),
  }), await safeJson(c));
  const task = await enqueueTask(body, p.id);
  return c.json(ok(task, c.get("requestId") ?? ""), 201);
});

agents.post("/api/v1/tasks/:id/complete", async (c) => {
  const p = await requireScope(c, "memory:write");
  const body = parse(z.object({ output: z.unknown() }), await safeJson(c));
  await completeTask(c.req.param("id"), body.output, p.id);
  broadcastSSE({ type: "task.update", data: { id: c.req.param("id"), status: "succeeded" }, timestamp: Date.now() });
  return c.json(ok({ completed: true }, c.get("requestId") ?? ""));
});

agents.post("/api/v1/tasks/:id/fail", async (c) => {
  const p = await requireScope(c, "memory:write");
  const body = parse(z.object({ error: z.string() }), await safeJson(c));
  await failTask(c.req.param("id"), body.error, p.id);
  broadcastSSE({ type: "task.update", data: { id: c.req.param("id"), status: "failed" }, timestamp: Date.now() });
  return c.json(ok({ failed: true }, c.get("requestId") ?? ""));
});

agents.get("/api/v1/worker/status", async (c) => {
  await requireScope(c, "memory:read");
  const { workerStatus } = await import("../services/task-worker.js");
  return c.json(ok(workerStatus(), c.get("requestId") ?? ""));
});

agents.post("/api/v1/worker/start", async (c) => {
  const p = await requireScope(c, "brain:admin");
  const { startWorker } = await import("../services/task-worker.js");
  startWorker(p.id);
  return c.json(ok({ running: true }, c.get("requestId") ?? ""));
});

agents.post("/api/v1/worker/stop", async (c) => {
  await requireScope(c, "brain:admin");
  const { stopWorker } = await import("../services/task-worker.js");
  stopWorker();
  return c.json(ok({ running: false }, c.get("requestId") ?? ""));
});

agents.post("/api/v1/worker/configure", async (c) => {
  await requireScope(c, "brain:admin");
  const body = parse(z.object({
    pollIntervalMs: z.number().int().min(500).max(60000).optional(),
    maxConcurrency: z.number().int().min(1).max(20).optional(),
    defaultTimeoutMs: z.number().int().min(5000).max(600000).optional(),
  }), await safeJson(c));
  const { configureWorker } = await import("../services/task-worker.js");
  configureWorker(body);
  return c.json(ok({ configured: true }, c.get("requestId") ?? ""));
});

agents.get("/api/v1/cron", async (c) => {
  await requireScope(c, "memory:read");
  return c.json(ok({ items: await listCronJobs() }, c.get("requestId") ?? ""));
});

agents.post("/api/v1/cron", async (c) => {
  const p = await requireScope(c, "brain:admin");
  const body = parse(z.object({
    name: z.string().min(1), cron: z.string().min(1), agentKind: z.string().default("daemon"),
    taskLabel: z.string().min(1), taskInput: z.unknown().optional(),
  }), await safeJson(c));
  const job = await createCronJob(body, p.id);
  return c.json(ok(job, c.get("requestId") ?? ""), 201);
});

agents.post("/api/v1/cron/:id/toggle", async (c) => {
  const p = await requireScope(c, "brain:admin");
  const body = parse(z.object({ enabled: z.boolean() }), await safeJson(c));
  const job = await toggleCronJob(c.req.param("id"), body.enabled, p.id);
  return c.json(ok(job, c.get("requestId") ?? ""));
});

agents.post("/api/v1/cron/tick", async (c) => {
  const p = await requireScope(c, "brain:admin");
  const fired = await tickCron(p.id);
  if (fired > 0) broadcastSSE({ type: "cron.fired", data: { fired }, timestamp: Date.now() });
  return c.json(ok({ fired }, c.get("requestId") ?? ""));
});

agents.post("/api/v1/ambient/ingest", async (c) => {
  const p = await requireScope(c, "memory:write");
  const body = parse(z.object({
    transcript: z.string().min(1), source: z.string().default("ambient"),
    metadata: z.record(z.string(), z.string()).default({}),
  }), await safeJson(c));
  const result = await ingestAmbientTranscript(body.transcript, body.source || "ambient", body.metadata as Record<string, string>, p.id);
  return c.json(ok(result, c.get("requestId") ?? ""), 201);
});
