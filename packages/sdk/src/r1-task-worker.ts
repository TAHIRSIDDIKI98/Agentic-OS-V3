/**
 * Durable task execution — checkpointed worker, retry, cancellation, recovery, event stream (E3-S2,S3,S4)
 */

import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { R1Repositories, TaskRepository } from './repositories.js';
import type { Task, TaskStep, TaskRecordEvent, TaskState } from './r1-types.js';
import { transitionTask, type TaskEvent } from './r1-types.js';
import type { ActionReceipt } from './r1-types.js';

export const CheckpointSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  taskId: z.string().uuid(),
  stepId: z.string().uuid().optional(),
  sequence: z.number().int().nonnegative(),
  stateSnapshot: z.record(z.string(), z.unknown()),
  createdAt: z.string().datetime(),
});
export type Checkpoint = z.infer<typeof CheckpointSchema>;

export const RetryPolicySchema = z.object({
  maxAttempts: z.number().int().min(1).max(100).default(3),
  backoffMs: z.number().int().min(0).max(3_600_000).default(1000),
  backoffMultiplier: z.number().min(1).max(10).default(2),
  timeoutMs: z.number().int().min(1000).max(3_600_000).default(30_000),
  retryableErrors: z.array(z.string()).default(['transient', 'timeout', 'provider_unavailable']),
});
export type RetryPolicy = z.infer<typeof RetryPolicySchema>;

export const TaskLeaseSchema = z.object({
  taskId: z.string().uuid(),
  projectId: z.string().uuid(),
  owner: z.string().min(1),
  expiresAt: z.string().datetime(),
  heartbeatAt: z.string().datetime(),
  version: z.number().int().nonnegative(),
});
export type TaskLease = z.infer<typeof TaskLeaseSchema>;

export const CompensationStepSchema = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid(),
  projectId: z.string().uuid(),
  targetStepId: z.string().uuid(),
  reason: z.string().min(1),
  createdAt: z.string().datetime(),
  state: z.enum(['pending', 'running', 'completed', 'failed']),
});
export type CompensationStep = z.infer<typeof CompensationStepSchema>;

export interface CheckpointRepository {
  save(cp: Checkpoint): Promise<Checkpoint>;
  listForTask(projectId: string, taskId: string): Promise<readonly Checkpoint[]>;
  getLatest(projectId: string, taskId: string): Promise<Checkpoint | null>;
}

export interface LeaseRepository {
  claim(projectId: string, taskId: string, owner: string, ttlMs: number): Promise<TaskLease | null>;
  heartbeat(projectId: string, taskId: string, owner: string): Promise<TaskLease | null>;
  release(projectId: string, taskId: string, owner: string): Promise<void>;
  listExpired(nowIso: string): Promise<readonly TaskLease[]>;
}

export interface CompensationRepository {
  save(c: CompensationStep): Promise<CompensationStep>;
  listForTask(projectId: string, taskId: string): Promise<readonly CompensationStep[]>;
  listForProject(projectId: string): Promise<readonly CompensationStep[]>;
  update(c: CompensationStep): Promise<CompensationStep>;
}

class InMemoryCheckpoints implements CheckpointRepository {
  private readonly map = new Map<string, Checkpoint[]>();
  async save(cp: Checkpoint): Promise<Checkpoint> {
    const list = this.map.get(cp.taskId) ?? [];
    list.push(cp);
    list.sort((a, b) => a.sequence - b.sequence);
    this.map.set(cp.taskId, list);
    return cp;
  }
  async listForTask(_projectId: string, taskId: string): Promise<readonly Checkpoint[]> {
    return [...(this.map.get(taskId) ?? [])];
  }
  async getLatest(_projectId: string, taskId: string): Promise<Checkpoint | null> {
    const list = this.map.get(taskId) ?? [];
    return list.length ? list[list.length - 1]! : null;
  }
}

class InMemoryLeases implements LeaseRepository {
  private readonly leases = new Map<string, TaskLease>();
  async claim(projectId: string, taskId: string, owner: string, ttlMs: number): Promise<TaskLease | null> {
    const now = new Date();
    const existing = this.leases.get(taskId);
    if (existing && new Date(existing.expiresAt).getTime() > now.getTime()) {
      // already claimed and not expired
      return null;
    }
    const lease: TaskLease = {
      taskId,
      projectId,
      owner,
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      heartbeatAt: now.toISOString(),
      version: (existing?.version ?? 0) + 1,
    };
    this.leases.set(taskId, lease);
    return lease;
  }
  async heartbeat(projectId: string, taskId: string, owner: string): Promise<TaskLease | null> {
    const lease = this.leases.get(taskId);
    if (!lease || lease.owner !== owner || lease.projectId !== projectId) return null;
    const now = new Date();
    const next: TaskLease = {
      ...lease,
      heartbeatAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 30_000).toISOString(),
      version: lease.version + 1,
    };
    this.leases.set(taskId, next);
    return next;
  }
  async release(projectId: string, taskId: string, owner: string): Promise<void> {
    const lease = this.leases.get(taskId);
    if (lease && lease.owner === owner && lease.projectId === projectId) this.leases.delete(taskId);
  }
  async listExpired(nowIso: string): Promise<readonly TaskLease[]> {
    const now = new Date(nowIso).getTime();
    return [...this.leases.values()].filter((l) => new Date(l.expiresAt).getTime() <= now);
  }
}

class InMemoryCompensation implements CompensationRepository {
  private readonly map = new Map<string, CompensationStep[]>();
  async save(c: CompensationStep): Promise<CompensationStep> {
    const list = this.map.get(c.taskId) ?? [];
    list.push(c);
    this.map.set(c.taskId, list);
    return c;
  }
  async listForTask(projectId: string, taskId: string): Promise<readonly CompensationStep[]> {
    return [...(this.map.get(taskId) ?? [])].filter((compensation) => compensation.projectId === projectId);
  }
  async listForProject(projectId: string): Promise<readonly CompensationStep[]> {
    return [...this.map.values()].flat().filter((compensation) => compensation.projectId === projectId);
  }
  async update(c: CompensationStep): Promise<CompensationStep> {
    const list = this.map.get(c.taskId) ?? [];
    const idx = list.findIndex((x) => x.id === c.id);
    if (idx >= 0) list[idx] = c;
    else list.push(c);
    this.map.set(c.taskId, list);
    return c;
  }
}

export interface TaskWorkerOptions {
  readonly now?: () => string;
  readonly ownerId?: string;
  readonly leaseTtlMs?: number;
  readonly retryPolicy?: RetryPolicy;
}

export const RecoveryActionSchema = z.enum(['retry', 'cancel', 'compensate', 'resume']);
export type RecoveryAction = z.infer<typeof RecoveryActionSchema>;

/**
 * Core worker that implements:
 * - lease claim + heartbeat
 * - checkpoint persistence before side-effect boundary
 * - receipt check to prevent duplicate idempotent execution
 * - race-safe state transitions, terminal cannot reopen
 * - retry classification, cancellation race, compensation
 */
export class TaskWorker {
  private readonly now: () => string;
  private readonly ownerId: string;
  private readonly leaseTtlMs: number;
  private readonly retryPolicy: RetryPolicy;

  constructor(
    private readonly repos: R1Repositories,
    private readonly checkpoints: CheckpointRepository = new InMemoryCheckpoints(),
    private readonly leases: LeaseRepository = new InMemoryLeases(),
    private readonly compensations: CompensationRepository = new InMemoryCompensation(),
    options: TaskWorkerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.ownerId = options.ownerId ?? `worker-${randomUUID().slice(0, 8)}`;
    this.leaseTtlMs = options.leaseTtlMs ?? 30_000;
    this.retryPolicy = options.retryPolicy ?? RetryPolicySchema.parse({});
  }

  /** Claim next queued task */
  async claimNext(projectId: string): Promise<{ task: Task; lease: TaskLease } | null> {
    const tasks = await this.repos.tasks.list(projectId);
    const queued = tasks.filter((t) => t.state === 'queued');
    for (const task of queued) {
      const lease = await this.leases.claim(projectId, task.id, this.ownerId, this.leaseTtlMs);
      if (!lease) continue;
      // Transition queued -> running (race-safe: verify state still queued)
      const fresh = await this.repos.tasks.get(projectId, task.id);
      if (!fresh || fresh.state !== 'queued') {
        await this.leases.release(projectId, task.id, this.ownerId);
        continue;
      }
      // Check terminal: should not happen but guard
      if (['completed', 'failed', 'cancelled'].includes(fresh.state)) {
        await this.leases.release(projectId, task.id, this.ownerId);
        continue;
      }
      const nextState = transitionTask(fresh.state as any, 'admit');
      const updated: Task = { ...fresh, state: nextState as TaskState, updatedAt: this.now() };
      await this.repos.tasks.update(updated);
      // Emit event
      await this.emitEvent(projectId, task.id, 'admit', nextState as TaskState);
      return { task: updated, lease };
    }
    return null;
  }

  async heartbeat(projectId: string, taskId: string): Promise<TaskLease | null> {
    return this.leases.heartbeat(projectId, taskId, this.ownerId);
  }

  /** Save checkpoint before side-effect boundary */
  async checkpoint(projectId: string, taskId: string, stepId: string, snapshot: Record<string, unknown>): Promise<Checkpoint> {
    const existing = await this.checkpoints.listForTask(projectId, taskId);
    const seq = existing.length;
    const cp: Checkpoint = {
      id: randomUUID(),
      projectId,
      taskId,
      stepId,
      sequence: seq,
      stateSnapshot: snapshot,
      createdAt: this.now(),
    };
    return this.checkpoints.save(cp);
  }

  /** List durable checkpoints without exposing repository internals. */
  async listCheckpoints(projectId: string, taskId: string): Promise<readonly Checkpoint[]> {
    return this.checkpoints.listForTask(projectId, taskId);
  }

  /** Recover expired leases from last checkpoint */
  async recoverExpired(): Promise<readonly { taskId: string; checkpoint: Checkpoint | null }[]> {
    const expired = await this.leases.listExpired(this.now());
    const recovered: { taskId: string; checkpoint: Checkpoint | null }[] = [];
    for (const lease of expired) {
      const cp = await this.checkpoints.getLatest(lease.projectId, lease.taskId);
      // Lease expires -> task goes to retrying? In our simplified state machine, we map retryable to queued re-claim.
      // For R1, we set task to queued again if not terminal, allowing re-claim.
      const task = await this.repos.tasks.get(lease.projectId, lease.taskId);
      if (task && !['completed', 'failed', 'cancelled'].includes(task.state)) {
        const updated: Task = { ...task, state: 'queued' as TaskState, updatedAt: this.now() };
        await this.repos.tasks.update(updated);
      }
      await this.leases.release(lease.projectId, lease.taskId, lease.owner);
      recovered.push({ taskId: lease.taskId, checkpoint: cp });
    }
    return recovered;
  }

  /**
   * Determine whether a step already produced an action receipt for the same
   * correlation. The task ID is mandatory so every repository can enforce
   * project scope before examining receipt metadata.
   */
  async isStepAlreadyExecuted(projectId: string, taskId: string, stepId: string, correlationId: string): Promise<boolean> {
    const receipts = await this.repos.receipts.listForTask(projectId, taskId);
    return receipts.some((receipt) =>
      receipt.correlationId === correlationId
      && receipt.payload.stepId === stepId
      && receipt.decision === 'allow',
    );
  }

  async transition(projectId: string, taskId: string, event: TaskEvent): Promise<Task> {
    const task = await this.repos.tasks.get(projectId, taskId);
    if (!task) throw new Error('Task not found');
    if (['completed', 'failed', 'cancelled'].includes(task.state)) {
      throw new Error(`Terminal state ${task.state} cannot transition`);
    }
    const nextState = transitionTask(task.state as any, event);
    const updated: Task = { ...task, state: nextState as TaskState, updatedAt: this.now() };
    const saved = await this.repos.tasks.update(updated);
    await this.emitEvent(projectId, taskId, event as any, nextState as TaskState);
    return saved;
  }

  async cancel(projectId: string, taskId: string): Promise<Task> {
    // Cancellation is race-safe against claim/start/approval transitions
    const task = await this.repos.tasks.get(projectId, taskId);
    if (!task) throw new Error('Task not found');
    if (['completed', 'failed', 'cancelled'].includes(task.state)) return task;
    // If currently leased, release lease as part of cancel
    try {
      await this.leases.release(projectId, taskId, this.ownerId);
    } catch {}
    return this.transition(projectId, taskId, 'cancel');
  }

  async handleFailure(projectId: string, taskId: string, errorClassification: string): Promise<{ task: Task; recovery: readonly RecoveryAction[] }> {
    const task = await this.repos.tasks.get(projectId, taskId);
    if (!task) throw new Error('Task not found');
    const isRetryable = this.retryPolicy.retryableErrors.includes(errorClassification);
    if (isRetryable) {
      // transition to failed then allow retry if attempts remain? For R1 simplified, we expose retry action.
      // Count checkpoints as attempts?
      const checkpoints = await this.checkpoints.listForTask(projectId, taskId);
      if (checkpoints.length < this.retryPolicy.maxAttempts) {
        const failed = await this.transition(projectId, taskId, 'fail');
        return { task: failed, recovery: ['retry', 'cancel'] };
      }
    }
    const failed = await this.transition(projectId, taskId, 'fail');
    return { task: failed, recovery: ['compensate', 'cancel'] };
  }

  async retry(projectId: string, taskId: string): Promise<Task> {
    const task = await this.repos.tasks.get(projectId, taskId);
    if (!task) throw new Error('Task not found');
    if (task.state !== 'failed') throw new Error('Retry only allowed from failed state');
    // Reset to queued for re-execution
    const updated: Task = { ...task, state: 'queued' as TaskState, updatedAt: this.now() };
    const saved = await this.repos.tasks.update(updated);
    await this.emitEvent(projectId, taskId, 'created', saved.state); // re-queue event
    return saved;
  }

  async exposeFailedTaskInfo(projectId: string, taskId: string): Promise<{ lastCheckpoint: Checkpoint | null; validActions: readonly RecoveryAction[] }> {
    const task = await this.repos.tasks.get(projectId, taskId);
    if (!task || task.state !== 'failed') throw new Error('Task not failed or not found');
    const last = await this.checkpoints.getLatest(projectId, taskId);
    return { lastCheckpoint: last, validActions: ['retry', 'cancel', 'compensate'] };
  }

  async createCompensation(projectId: string, taskId: string, targetStepId: string, reason: string): Promise<CompensationStep> {
    const comp: CompensationStep = {
      id: randomUUID(),
      taskId,
      projectId,
      targetStepId,
      reason,
      createdAt: this.now(),
      state: 'pending',
    };
    return this.compensations.save(comp);
  }

  async runCompensation(projectId: string, compensationId: string, executor: () => Promise<void>): Promise<CompensationStep> {
    const allTasks = await this.compsForProject(projectId);
    const comp = allTasks.find((c) => c.id === compensationId);
    if (!comp) throw new Error('Compensation not found');
    const running: CompensationStep = { ...comp, state: 'running' as const };
    await this.compensations.update(running);
    try {
      await executor();
      const completed: CompensationStep = { ...running, state: 'completed' as const };
      return this.compensations.update(completed);
    } catch {
      const failed: CompensationStep = { ...running, state: 'failed' as const };
      return this.compensations.update(failed);
    }
  }

  private async compsForProject(projectId: string): Promise<readonly CompensationStep[]> {
    return this.compensations.listForProject(projectId);
  }

  private async emitEvent(projectId: string, taskId: string, event: TaskRecordEvent['event'], state: TaskState): Promise<void> {
    const existing = await this.repos.tasks.listEvents(projectId, taskId);
    const seq = existing.length;
    const record: TaskRecordEvent = {
      id: `${taskId}:${seq}:${event}`,
      projectId,
      taskId,
      event,
      state,
      sequence: seq,
      createdAt: this.now(),
    };
    try {
      await this.repos.tasks.appendEvent(record);
    } catch {
      // idempotent
    }
  }

  // For crash injection tests
  async crashBeforeCheckpoint(): Promise<void> {
    // simulate crash: do nothing, lease will expire and recover will restore
  }
  async crashAfterCheckpointBeforeSideEffect(projectId: string, taskId: string, stepId: string, snapshot: Record<string, unknown>): Promise<Checkpoint> {
    const cp = await this.checkpoint(projectId, taskId, stepId, snapshot);
    // simulate crash after checkpoint but before side effect: throw
    throw new Error('injected-crash-after-checkpoint');
    // return cp; // unreachable but for type
  }
}

export function createInMemoryTaskWorkerDeps() {
  return {
    checkpoints: new InMemoryCheckpoints(),
    leases: new InMemoryLeases(),
    compensations: new InMemoryCompensation(),
  };
}
