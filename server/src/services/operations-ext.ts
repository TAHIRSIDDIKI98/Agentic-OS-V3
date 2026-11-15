/**
 * services/operations-ext.ts — Extended operations for Phases 2-5.
 *
 * Contains: Cron daemon management, ambient voice ingestion,
 * HITL approval gates, Zod auto-correction loop, circuit breaker.
 */
import { db, isSqlite } from '../db/client.js';
import { cronJobs, agentTasks, stateSnapshots } from '../db/client.js';

/** SQLite stores JSON-shaped columns as text; Postgres jsonb needs the raw value. */
const jsonColumn = <T>(value: T): T | string => (isSqlite ? JSON.stringify(value) : value);
import { appendAudit } from '../lib/audit.js';
import { enqueueTask, spawnAgent } from './kernel.js';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import { env } from '../lib/env.js';
import { CronExpressionParser } from 'cron-parser';
import { broadcastSSE } from './sse-bus.js';

// ── PHASE 4: Cron Daemons (24/7 Autonomous Waking) ────────────

export interface CronJobInput {
  name: string;
  cron: string; // e.g. "0 9 * * *" = daily at 9am
  agentKind?: string;
  taskLabel: string;
  taskInput?: unknown;
}

/**
 * Schedule a 24/7 autonomous daemon. The cron scheduler wakes periodically,
 * checks for due jobs, spawns a daemon agent, and enqueues the task.
 */
export async function createCronJob(input: CronJobInput, actor: string) {
  const nextRunAt = computeNextRun(input.cron);
  const [job] = await db
    .insert(cronJobs)
    .values({
      id: `crn_${randomUUID()}`,
      name: input.name,
      cron: input.cron,
      agentKind: input.agentKind ?? 'daemon',
      taskLabel: input.taskLabel,
      // Plain-text column in SQLite: serialize here (see schema-sqlite.ts).
      // Postgres keeps jsonb, which drizzle serializes itself.
      taskInput: jsonColumn(input.taskInput ?? {}),
      enabled: true,
      nextRunAt,
      runCount: 0,
    })
    .returning();

  if (!job) throw new Error('Failed to create cron job — DB returned no row.');
  await appendAudit('cron.created', { jobId: job.id, name: input.name, cron: input.cron }, actor);
  return job;
}

/** List all cron jobs. */
export async function listCronJobs() {
  return db.select().from(cronJobs).orderBy(cronJobs.createdAt);
}

/** Toggle a cron job on/off. */
export async function toggleCronJob(id: string, enabled: boolean, actor: string) {
  const [updated] = await db
    .update(cronJobs)
    .set({ enabled })
    .where(eq(cronJobs.id, id))
    .returning();
  await appendAudit('cron.toggled', { jobId: id, enabled }, actor);
  return updated;
}

/**
 * Tick the cron scheduler. Finds all enabled jobs whose nextRunAt <= now,
 * spawns a daemon agent, enqueues the task, and advances nextRunAt.
 * Called periodically by the kernel's event loop.
 */
export async function tickCron(actor: string): Promise<number> {
  const now = new Date();
  const due = await db.query.cronJobs.findMany({
    where: eq(cronJobs.enabled, true),
  });

  let fired = 0;
  for (const job of due) {
    if (!job.nextRunAt || job.nextRunAt > now) continue;

    // Spawn a daemon agent
    const agent = await spawnAgent(
      {
        name: `${job.name}-daemon`,
        kind: 'daemon',
        ring: 1,
        scopes: ['memory:read', 'memory:write'],
      },
      actor
    );

    if (!agent) continue;

    // Enqueue the task
    await enqueueTask(
      {
        agentId: agent.id,
        label: job.taskLabel,
        kind: 'maintenance',
        input: job.taskInput,
        idempotencyKey: `cron_${job.id}_${job.nextRunAt.toISOString()}`,
      },
      actor
    );

    // Advance next run
    const nextRun = computeNextRun(job.cron);
    await db
      .update(cronJobs)
      .set({
        lastRunAt: now,
        nextRunAt: nextRun,
        runCount: job.runCount + 1,
      })
      .where(eq(cronJobs.id, job.id));

    fired++;
  }

  if (fired > 0) {
    await appendAudit('cron.ticked', { fired, time: now.toISOString() }, actor);
  }

  return fired;
}

function computeNextRun(cronExpr: string): Date {
  try {
    const interval = CronExpressionParser.parse(cronExpr);
    return interval.next().toDate();
  } catch {
    const fallback = new Date(Date.now() + 60000);
    fallback.setSeconds(0, 0);
    return fallback;
  }
}

// ── PHASE 4: Ambient Voice Ingestion ──────────────────────────

/**
 * Ingest ambient voice transcripts from wearables (OMI), mobile devices,
 * or Apple Shortcuts. Drops the transcript into the Q2 background queue
 * for distillation via session capture.
 */
export async function ingestAmbientTranscript(
  transcript: string,
  source: string,
  metadata: Record<string, string>,
  actor: string
): Promise<{ taskId: string; agentId: string }> {
  // Spawn a background daemon to distill
  const agent = await spawnAgent(
    {
      name: `ambient-ingest-${Date.now()}`,
      kind: 'daemon',
      ring: 2,
      scopes: ['memory:write'],
    },
    actor
  );

  if (!agent) throw new Error('Failed to spawn ambient agent.');

  // Enqueue the distillation task
  const task = await enqueueTask(
    {
      agentId: agent.id,
      label: `Ambient distillation from ${source}`,
      kind: 'background',
      input: { transcript, source, metadata },
      idempotencyKey: `ambient_${createHash(transcript.slice(0, 100))}`,
    },
    actor
  );

  if (!task) throw new Error('Failed to enqueue ambient task.');

  await appendAudit(
    'ambient.ingested',
    {
      source,
      length: transcript.length,
      taskId: task.id,
    },
    actor
  );

  return { taskId: task.id, agentId: agent.id };
}

function createHash(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
  }
  return hash.toString(16);
}

// ── HITL: Approval Gates ──────────────────────────────────────

export interface ApprovalRequest {
  agentId: string;
  taskId: string;
  tool: string;
  riskLevel: string;
  payload: unknown;
  reasoning: string;
}

/**
 * Request human approval for a high-risk tool call.
 * The agent's execution is suspended until the human responds.
 * Emits an approval.requested event for SSE streaming.
 */
export async function requestApproval(
  req: ApprovalRequest,
  actor: string
): Promise<{ approvalId: string }> {
  const approvalId = `apv_${randomUUID()}`;

  // Store in the task's metadata as a pending approval
  await db
    .update(agentTasks)
    .set({
      error: `PENDING_APPROVAL:${approvalId}`,
      status: 'running', // stays running but blocked
    })
    .where(eq(agentTasks.id, req.taskId));

  await appendAudit(
    'approval.requested',
    {
      approvalId,
      agentId: req.agentId,
      taskId: req.taskId,
      tool: req.tool,
      riskLevel: req.riskLevel,
      payload: req.payload,
      reasoning: req.reasoning,
    },
    actor
  );

  broadcastSSE({
    type: 'approval.requested',
    data: {
      approvalId,
      agentId: req.agentId,
      taskId: req.taskId,
      tool: req.tool,
      riskLevel: req.riskLevel,
      reasoning: req.reasoning,
    },
    timestamp: Date.now(),
  });

  return { approvalId };
}

/**
 * Resolve a pending approval. If approved, the agent's task continues.
 * If denied, the task is cancelled and the agent is notified.
 * The human's authorization is logged to the audit chain.
 */
export async function resolveApproval(
  taskId: string,
  approved: boolean,
  operatorName: string
): Promise<void> {
  const task = await db.query.agentTasks.findFirst({ where: eq(agentTasks.id, taskId) });
  if (!task) throw new Error('Task not found');

  if (approved) {
    await db
      .update(agentTasks)
      .set({
        status: 'queued',
        error: null,
      })
      .where(eq(agentTasks.id, taskId));

    await appendAudit('approval.approved', { taskId, operator: operatorName }, operatorName);
    broadcastSSE({
      type: 'task.update',
      data: { taskId, status: 'queued', approved: true, operator: operatorName },
      timestamp: Date.now(),
    });
    (await import('./task-worker.js')).wakeWorker();
  } else {
    await db
      .update(agentTasks)
      .set({
        status: 'cancelled',
        error: 'Denied by operator',
        finishedAt: new Date(),
      })
      .where(eq(agentTasks.id, taskId));

    await appendAudit('approval.denied', { taskId, operator: operatorName }, operatorName);
    broadcastSSE({
      type: 'task.update',
      data: { taskId, status: 'cancelled', approved: false, operator: operatorName },
      timestamp: Date.now(),
    });
  }
}

// ── Self-Healing: Zod Auto-Correction ─────────────────────────

export interface AutoCorrectionResult<T> {
  success: boolean;
  data?: T;
  error?: string;
  attempts: number;
  corrections: string[];
}

/**
 * Zod-Driven Auto-Correction Loop.
 *
 * If an agent's output fails Zod validation, this loop:
 *  1. Intercepts the validation error
 *  2. Formats it as a "System Error" observation
 *  3. Feeds it back to the caller (or agent) for correction
 *  4. Retries up to MAX_RETRIES (3) times
 *
 * On the 4th failure, it throws to trigger graceful degradation.
 */
export async function validateWithRetry<T>(
  schema: z.ZodType<T>,
  rawOutput: unknown,
  maxRetries = 3,
  retryFn?: (error: string, attempt: number) => Promise<unknown>
): Promise<AutoCorrectionResult<T>> {
  const corrections: string[] = [];

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    const result = schema.safeParse(rawOutput);

    if (result.success) {
      return { success: true, data: result.data, attempts: attempt, corrections };
    }

    // Format the Zod error as a system observation for the agent
    const errorMsg = result.error.issues
      .map((i) => `[${i.path.join('.') || 'root'}] ${i.message}`)
      .join('; ');

    const observation =
      `SYSTEM ERROR: Your output failed validation. ` + `Fix these issues and retry: ${errorMsg}`;

    corrections.push(`Attempt ${attempt}: ${observation}`);

    if (attempt > maxRetries) {
      // Exhausted retries — return failure for graceful degradation
      return {
        success: false,
        error: `Validation failed after ${maxRetries} retries: ${errorMsg}`,
        attempts: attempt,
        corrections,
      };
    }

    // If a retry function is provided, get corrected output from the agent
    if (retryFn) {
      rawOutput = await retryFn(observation, attempt);
    } else {
      // No retry function — return the error immediately
      return {
        success: false,
        error: observation,
        attempts: attempt,
        corrections,
      };
    }
  }

  return { success: false, error: 'Exhausted retries', attempts: maxRetries + 1, corrections };
}

// ── Stability: Circuit Breaker ────────────────────────────────

interface CircuitBreakerState {
  failures: number;
  lastFailureAt: number;
  tripped: boolean;
}

const breakers = new Map<string, CircuitBreakerState>();

const CB_THRESHOLD = env.NEXUS_CB_THRESHOLD;
const CB_RESET_MS = env.NEXUS_CB_RESET_MS;

/**
 * Circuit breaker wrapper. If a function fails CB_THRESHOLD times in a row,
 * the breaker trips and immediately rejects subsequent calls for CB_RESET_MS.
 * Prevents infinite error loops and wasted token spend.
 */
export async function withCircuitBreaker<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const state = breakers.get(key) ?? { failures: 0, lastFailureAt: 0, tripped: false };

  // Check if breaker should reset
  if (state.tripped && Date.now() - state.lastFailureAt > CB_RESET_MS) {
    state.tripped = false;
    state.failures = 0;
  }

  if (state.tripped) {
    throw new Error(
      `CIRCUIT_BREAKER_TRIPPED: ${key} has failed ${state.failures} times. ` +
        `Retry in ${Math.ceil((CB_RESET_MS - (Date.now() - state.lastFailureAt)) / 1000)}s.`
    );
  }

  try {
    const result = await fn();
    state.failures = 0; // reset on success
    breakers.set(key, state);
    return result;
  } catch (err) {
    state.failures++;
    state.lastFailureAt = Date.now();
    if (state.failures >= CB_THRESHOLD) {
      state.tripped = true;
    }
    breakers.set(key, state);
    throw err;
  }
}

/** Get the current state of a circuit breaker (for dashboard display). */
export function getCircuitBreakerState(key: string): CircuitBreakerState | null {
  const state = breakers.get(key);
  if (!state) return null;
  return { ...state };
}

// ── Long-Horizon State Snapshots ──────────────────────────────

/**
 * Save a state snapshot for a saga at a specific step.
 * If the agent crashes, a recovery agent can hydrate from this snapshot
 * and resume from exactly this step without restarting.
 */
export async function saveSnapshot(
  sagaId: string,
  agentId: string,
  stepIndex: number,
  stepName: string,
  context: unknown,
  actor: string
): Promise<string> {
  const snapId = `snp_${randomUUID()}`;
  await db.insert(stateSnapshots).values({
    id: snapId,
    sagaId,
    agentId,
    stepIndex,
    stepName,
    context,
  });

  await appendAudit('snapshot.saved', { snapId, sagaId, stepIndex, stepName }, actor);
  return snapId;
}

/** Load the latest snapshot for a saga (for crash recovery). */
export async function loadLatestSnapshot(sagaId: string) {
  const { desc } = await import('drizzle-orm');
  const snaps = await db.query.stateSnapshots.findMany({
    where: eq(stateSnapshots.sagaId, sagaId),
    orderBy: desc(stateSnapshots.stepIndex),
    limit: 1,
  });
  return snaps[0] ?? null;
}
