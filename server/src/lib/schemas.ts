/**
 * schemas.ts — Zod input validation for every API & MCP boundary.
 */
import { z } from "zod";

export const MEMORY_KINDS = z.enum(["episodic", "semantic", "preference", "reflexion", "fact"]);

export const memoryInput = z.object({
  kind: MEMORY_KINDS.default("semantic"),
  title: z.string().trim().min(1).max(200),
  content: z.string().trim().min(1),
  tags: z.array(z.string().trim().min(1)).max(20).default([]),
  importance: z.number().min(0).max(1).default(0.5),
  source: z.string().trim().max(120).default("manual"),
  projectId: z.string().trim().max(80).nullable().default(null),
});

export const memoryPatch = memoryInput.partial();

export const skillInput = z.object({
  name: z.string().trim().min(1).max(120).regex(/^[a-z0-9-]+$/, "must be lowercase kebab-case"),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(400),
  content: z.string().trim().min(1),
  category: z.string().trim().min(1).max(60).default("general"),
  tags: z.array(z.string().trim().min(1)).max(20).default([]),
  trigger: z.string().trim().max(200).nullable().default(null),
  source: z.string().trim().max(120).default("manual"),
  projectId: z.string().trim().max(80).nullable().default(null),
});

export const recallQuery = z.object({
  q: z.string().trim().min(1),
  budget: z.coerce.number().int().min(64).max(8192).default(1500),
  cursor: z.coerce.number().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export const captureInput = z.object({
  transcript: z.string().trim().min(1),
  projectName: z.string().trim().max(120).optional(),
});

export const outcomeInput = z.object({ outcome: z.enum(["success", "failure"]) });

export const killSwitchInput = z.object({ enabled: z.boolean(), reason: z.string().trim().max(300).optional() });

export const feedbackInput = z.object({
  query: z.string().trim().min(1),
  itemId: z.string().trim().min(1),
  itemType: z.enum(["memory", "skill", "note"]),
  helpful: z.boolean(),
});

/* ════════════════════════════════════════════════════════════════
 * Phase 3-5: Multi-Agent, Cron, Browser, HITL schemas
 * ════════════════════════════════════════════════════════════════ */

export const spawnAgentInput = z.object({
  name: z.string().trim().min(1).max(80),
  kind: z.enum(["sub-agent", "daemon"]).default("sub-agent"),
  parentId: z.string().trim().optional(),
  ring: z.number().int().min(0).max(4).default(2),
  scopes: z.array(z.string()).default([]),
  llmModel: z.string().optional(),
  tokenBudget: z.number().int().min(1000).max(10_000_000).default(100000),
  timeoutMs: z.number().int().min(1000).max(3_600_000).default(120000),
});

export const updateAgentStateInput = z.object({
  status: z.string().trim().min(1),
  currentTool: z.string().optional(),
});

export const enqueueTaskInput = z.object({
  agentId: z.string().trim().min(1),
  label: z.string().trim().min(1),
  kind: z.string().default("interactive"),
  input: z.unknown().optional(),
  idempotencyKey: z.string().optional(),
});

export const cronJobInput = z.object({
  name: z.string().trim().min(1),
  cron: z.string().trim().min(1),
  agentKind: z.string().default("daemon"),
  taskLabel: z.string().trim().min(1),
  taskInput: z.unknown().optional(),
});

export const ambientIngestInput = z.object({
  transcript: z.string().trim().min(1),
  source: z.string().default("ambient"),
  metadata: z.record(z.string(), z.string()).default({}),
});

export const browserNavigateInput = z.object({
  url: z.string().url(),
  agentId: z.string().min(1),
});

export const browserClickInput = z.object({
  url: z.string().url(),
  selector: z.string().min(1),
  agentId: z.string().min(1),
});

export const browserExtractInput = z.object({
  url: z.string().url(),
  selector: z.string().optional(),
  agentId: z.string().min(1),
});

export const approvalRequestInput = z.object({
  agentId: z.string().min(1),
  taskId: z.string().min(1),
  tool: z.string().min(1),
  riskLevel: z.string(),
  payload: z.unknown(),
  reasoning: z.string(),
});

export const approvalResolveInput = z.object({
  taskId: z.string().min(1),
  approved: z.boolean(),
});

export const trajectoryInput = z.object({
  agentId: z.string().min(1),
  model: z.string().min(1),
  promptSent: z.string(),
  responseReceived: z.string().optional(),
  tokenUsage: z.object({
    prompt: z.number(),
    completion: z.number(),
    total: z.number(),
  }).optional(),
  latencyMs: z.number().optional(),
});

export const toolReceiptInput = z.object({
  agentId: z.string().min(1),
  tool: z.string().min(1),
  target: z.string().optional(),
  preState: z.string().optional(),
  postState: z.string().optional(),
  exitCode: z.number().optional(),
  authorized: z.boolean(),
});
