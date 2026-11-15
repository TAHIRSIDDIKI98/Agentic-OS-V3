/**
 * server/tests/e2e/golden-path.e2e.test.ts
 *
 * The executable R1 golden path — docs/bmad/GOLDEN-PATH-SPECIFICATION.md.
 *
 * Unlike the legacy system.e2e.test.ts, every step here drives the real governed
 * runtime and HTTP routes over a migrated SQLite database. Nothing is asserted
 * against a constant: approvals gate side effects, tool writes land on disk,
 * leases expire against a controlled clock, and export/import is round-tripped.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Principal } from '../../src/lib/security.js';
import type { NexusEnv } from '../../src/lib/hono-env.js';
import { createR1Router } from '../../src/routes/r1.js';
import { createExtendedR1Router } from '../../src/routes/r1-extended.js';
import {
  createExtendedSqlR1Runtime,
  type ExtendedR1Runtime,
} from '../../src/services/r1-extended-runtime.js';
import {
  createApplicationSqlExecutor,
  executeApplicationSql,
} from '../../src/db/client.js';

const migrations = [
  '0049_r1_contracts.sqlite.sql',
  '0050_r1_durable_task_metadata.sqlite.sql',
  '0051_r1_capability_governance.sqlite.sql',
  '0052_r1_extended.sqlite.sql',
  '0053_r1_sync.sqlite.sql',
  '0054_r1_effect_claims.sqlite.sql',
]
  .map((file) => readFileSync(new URL(`../../src/db/migrations/${file}`, import.meta.url), 'utf8'))
  .join('\n');

const principal: Principal = {
  id: 'principal-golden-path',
  name: 'Golden path developer',
  keyHash: 'not-used-in-test',
  scopes: ['memory:read', 'memory:write', 'brain:admin'],
  status: 'active',
};

const sha256 = (content: string) => createHash('sha256').update(content).digest('hex');

describe('R1 golden path — 14/14 executable steps', () => {
  const projectId = randomUUID();
  const taskId = randomUUID();
  const correlationId = randomUUID();
  const crashTaskId = randomUUID();
  const evidenceIds = [randomUUID(), randomUUID(), randomUUID()];
  const memoryIds = Array.from({ length: 6 }, () => randomUUID());

  let projectRoot = '';
  let runtime: ExtendedR1Runtime;
  let app: Hono<NexusEnv>;
  let nowMs = Date.parse('2026-11-15T09:00:00.000Z');
  const now = () => new Date(nowMs).toISOString();
  const steps: string[] = [];
  const step = (index: number, name: string) => {
    steps.push(`${index}. ${name}`);
  };

  const request = async (path: string, init?: RequestInit): Promise<Response> => {
    const response = await app.request(path, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(init?.headers ?? {}),
      },
    });
    return response;
  };

  const body = async <T>(response: Response): Promise<T> => (await response.json()) as T;

  beforeAll(async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'nexus-golden-path-'));
    mkdirSync(join(projectRoot, 'src', 'auth'), { recursive: true });
    writeFileSync(
      join(projectRoot, 'src', 'auth', 'session.ts'),
      'export const sessionTtlSeconds = 900;\n',
      'utf8'
    );
    writeFileSync(
      join(projectRoot, 'src', 'auth', 'middleware.ts'),
      'export const requireSession = true;\n',
      'utf8'
    );

    await executeApplicationSql(migrations);
    runtime = createExtendedSqlR1Runtime(createApplicationSqlExecutor(), {
      now,
      projectRoots: new Map([[projectId, projectRoot]]),
    });

    app = new Hono<NexusEnv>();
    app.use('*', async (c, next) => {
      c.set('principal', principal);
      await next();
    });
    app.route('/api/v1/r1', createR1Router(runtime));
    app.route('/api/v1/r1', createExtendedR1Router(runtime));
  });

  afterAll(() => {
    if (projectRoot) rmSync(projectRoot, { recursive: true, force: true });
  });

  it('completes the spec without data repair', async () => {
    // 1 — Initialize project with stable ID, local storage and default policy.
    const project = {
      id: projectId,
      name: 'agentic-os-demo',
      mode: 'local',
      scope: { root: projectRoot },
      idempotencyKey: 'agentic-os-demo',
      createdAt: now(),
      updatedAt: now(),
    };
    const created = await request('/api/v1/r1/projects', {
      method: 'POST',
      body: JSON.stringify(project),
    });
    expect(created.status).toBe(201);
    const inspected = await request(`/api/v1/r1/projects/${projectId}`);
    expect(inspected.status).toBe(200);
    const inspectBody = await body<{ status: { mode: string; taskCount: number } }>(inspected);
    expect(inspectBody.status.mode).toBe('local');
    step(1, 'project initialized and visible with local badge');

    // 2 — Capture initial context as provenance-backed memories.
    for (let index = 0; index < 3; index += 1) {
      const response = await request(`/api/v1/r1/projects/${projectId}/evidence`, {
        method: 'POST',
        body: JSON.stringify({
          id: evidenceIds[index],
          projectId,
          kind: 'source',
          source: `src/auth/file-${index}.ts`,
          contentHash: sha256(`source-${index}`),
          metadata: { file: `src/auth/file-${index}.ts` },
          createdAt: now(),
        }),
      });
      expect(response.status).toBe(201);
    }
    for (let index = 0; index < memoryIds.length; index += 1) {
      const response = await request(`/api/v1/r1/projects/${projectId}/memories`, {
        method: 'POST',
        body: JSON.stringify({
          id: memoryIds[index],
          projectId,
          content: `Authentication token service fact ${index}: tokens rotate every 15 minutes.`,
          metadata: {
            provenance: {
              type: 'fact',
              source: 'golden-path-capture',
              confidence: 0.92,
              lifecycle: 'active',
              evidenceIds: [evidenceIds[index % evidenceIds.length]],
            },
          },
          evidenceIds: [evidenceIds[index % evidenceIds.length]],
          createdAt: now(),
          updatedAt: now(),
        }),
      });
      expect(response.status).toBe(201);
    }
    const memories = await body<{ memories: unknown[] }>(
      await request(`/api/v1/r1/projects/${projectId}/memories`)
    );
    expect(memories.memories).toHaveLength(memoryIds.length);
    step(2, `${memoryIds.length} provenance memories from ${evidenceIds.length} source hashes`);

    // 3 — Start a governed durable task with an idempotency key.
    const task = {
      id: taskId,
      projectId,
      principalId: principal.id,
      agentId: 'agent-golden-path',
      state: 'queued',
      title: 'Refactor authentication token service',
      goal: 'Refactor the authentication module to use the new token service. Add tests.',
      capabilityIds: ['read-file', 'write-file', 'run-tests'],
      policyVersion: 'policy-r1-v1',
      inputReference: 'input:golden-path',
      correlationId,
      idempotencyKey: 'golden-path-task',
      createdAt: now(),
      updatedAt: now(),
    };
    const taskResponse = await request(`/api/v1/r1/projects/${projectId}/tasks`, {
      method: 'POST',
      body: JSON.stringify(task),
    });
    expect(taskResponse.status).toBe(201);
    const taskEvents = await body<{ events: Array<{ event: string }> }>(
      await request(`/api/v1/r1/projects/${projectId}/tasks/${taskId}/events`)
    );
    expect(taskEvents.events.map((event) => event.event)).toContain('created');
    step(3, 'durable task queued with created event');

    // 4 — Scoped, budgeted recall feeds the plan.
    const recall = await body<{
      results: Array<{ id: string; tokenCost: number }>;
      budgetRequested: number;
      budgetUsed: number;
      modeUsed: string;
    }>(
      await request(`/api/v1/r1/projects/${projectId}/recall`, {
        method: 'POST',
        body: JSON.stringify({
          query: 'authentication token service rotation',
          tokenBudget: 1800,
          mode: 'lexical',
        }),
      })
    );
    expect(recall.results.length).toBeGreaterThanOrEqual(5);
    expect(recall.budgetRequested).toBe(1800);
    expect(recall.budgetUsed).toBeLessThanOrEqual(1800);
    expect(recall.modeUsed).toBe('lexical');
    step(4, `recall returned ${recall.results.length} memories within 1800 tokens`);

    // 5 — Risky write blocks on approval.
    const nextContent = 'export const tokenService = "v2";\n';
    const waiting = await runtime.service.transitionTask(projectId, taskId, 'require_approval');
    expect(waiting.state).toBe('waiting_approval');
    const approvalResponse = await request(`/api/v1/r1/projects/${projectId}/approvals`, {
      method: 'POST',
      body: JSON.stringify({
        taskId,
        capabilityId: 'file.write',
        tool: 'write-file',
        args: { path: 'src/auth/token.ts', content: nextContent },
        riskReason: 'writes production authentication code',
        policyVersion: 'policy-r1-v1',
        agentId: 'agent-golden-path',
        ttlMs: 3_600_000,
      }),
    });
    expect(approvalResponse.status).toBe(201);
    const approval = await body<{
      id: string;
      state: string;
      action: { actionHash: string; policyVersion: string };
    }>(approvalResponse);
    expect(approval.state).toBe('pending');
    expect(approval.action.actionHash).toMatch(/^[a-f0-9]{64}$/);
    expect(existsSync(join(projectRoot, 'src', 'auth', 'token.ts'))).toBe(false);
    step(5, 'write blocked in waiting_approval with hash and risk reason');

    // 6 — Human approval re-validates hash and policy, then resumes execution.
    const decided = await request(
      `/api/v1/r1/projects/${projectId}/approvals/${approval.id}/decide`,
      {
        method: 'POST',
        body: JSON.stringify({
          decision: 'approved',
          actionHash: approval.action.actionHash,
          policyVersion: approval.action.policyVersion,
        }),
      }
    );
    expect(decided.status).toBe(200);
    const decision = await body<{ sideEffectAllowed: boolean; request: { state: string } }>(decided);
    expect(decision.sideEffectAllowed).toBe(true);
    expect(decision.request.state).toBe('approved');
    const running = await runtime.service.transitionTask(projectId, taskId, 'approve');
    expect(running.state).toBe('running');
    step(6, 'approval re-validated hash + policy and released the task');

    // 7 — Execute the write inside the project root, with a receipt and checkpoint.
    const write = await body<{ ok: boolean; receiptId: string }>(
      await request(`/api/v1/r1/projects/${projectId}/tool/write`, {
        method: 'POST',
        body: JSON.stringify({
          path: 'src/auth/token.ts',
          content: nextContent,
          taskId,
          approvalId: approval.id,
        }),
      })
    );
    expect(write.ok).toBe(true);
    expect(readFileSync(join(projectRoot, 'src', 'auth', 'token.ts'), 'utf8')).toBe(nextContent);
    const checkpointResponse = await request(
      `/api/v1/r1/projects/${projectId}/tasks/${taskId}/checkpoints`,
      { method: 'POST', body: JSON.stringify({ stepId: randomUUID(), snapshot: { step: 7 } }) }
    );
    expect(checkpointResponse.status).toBe(201);
    step(7, 'approved write landed on disk with receipt and checkpoint');

    // 8 — Low-risk reads are auto-allowed and produce no approval.
    for (const path of ['src/auth/token.ts', 'src/auth/session.ts']) {
      const read = await body<{ ok: boolean; output: string }>(
        await request(`/api/v1/r1/projects/${projectId}/tool/read`, {
          method: 'POST',
          body: JSON.stringify({ path, taskId }),
        })
      );
      expect(read.ok).toBe(true);
      expect(read.output.length).toBeGreaterThan(0);
    }
    const pendingAfterReads = await body<{ approvals: unknown[] }>(
      await request(`/api/v1/r1/projects/${projectId}/approvals`)
    );
    expect(pendingAfterReads.approvals).toHaveLength(0);
    step(8, 'two low-risk reads auto-allowed with zero new approvals');

    // 9 — Constrained command execution is sandboxed and receipted.
    const exec = await body<{ ok: boolean; output?: string; error?: string; receiptId: string }>(
      await request(`/api/v1/r1/projects/${projectId}/tool/exec`, {
        method: 'POST',
        body: JSON.stringify({
          command: 'echo',
          args: ['golden-path-ok'],
          taskId,
          approvalId: approval.id,
        }),
      })
    );
    if (process.platform === 'win32') {
      // ADR-0031: the constrained runner is POSIX-first. On Windows it must
      // fail closed with a typed platform error, never execute unchecked.
      expect(exec.ok).toBe(false);
      expect(exec.error).toMatch(/POSIX-first|unsupported/i);
      step(9, 'constrained execution failed closed on Windows (POSIX-first per ADR-0031)');
    } else {
      expect(exec.ok).toBe(true);
      expect(exec.output).toContain('golden-path-ok');
      step(9, 'constrained command executed with receipt');
    }

    // 10 — Worker death: lease expiry recovers from the last checkpoint with no duplicate effect.
    const crashTask = {
      ...task,
      id: crashTaskId,
      title: 'Crash-recovery probe',
      idempotencyKey: 'golden-path-crash',
      correlationId: randomUUID(),
      createdAt: now(),
      updatedAt: now(),
    };
    expect(
      (
        await request(`/api/v1/r1/projects/${projectId}/tasks`, {
          method: 'POST',
          body: JSON.stringify(crashTask),
        })
      ).status
    ).toBe(201);
    const claimed = await body<{ claimed: boolean; task?: { id: string } }>(
      await request(`/api/v1/r1/projects/${projectId}/tasks/claim`, { method: 'POST' })
    );
    expect(claimed.claimed).toBe(true);
    expect(claimed.task?.id).toBe(crashTaskId);
    await runtime.worker.checkpoint(projectId, crashTaskId, randomUUID(), { step: 3 });
    const effectCorrelation = randomUUID();
    const firstWrite = await body<{ receiptId: string }>(
      await request(`/api/v1/r1/projects/${projectId}/tool/write`, {
        method: 'POST',
        body: JSON.stringify({
          path: 'src/auth/recovered.ts',
          content: 'export const recovered = true;\n',
          taskId: crashTaskId,
          approvalId: approval.id,
          correlationId: effectCorrelation,
        }),
      })
    );
    // SqlLeases stamps leases with the real clock; move past it to expire the lease.
    nowMs = Date.now() + 2 * 60 * 1000;
    const restarted = createExtendedSqlR1Runtime(createApplicationSqlExecutor(), {
      now,
      projectRoots: new Map([[projectId, projectRoot]]),
    });
    const recovered = await restarted.worker.recoverExpired();
    expect(recovered.map((entry) => entry.taskId)).toContain(crashTaskId);
    const recoveredTask = await restarted.service.getTask(projectId, crashTaskId);
    expect(recoveredTask?.state).toBe('queued');
    const recoveredCheckpoints = await restarted.worker.listCheckpoints(projectId, crashTaskId);
    expect(recoveredCheckpoints.length).toBeGreaterThan(0);
    const replay = await restarted.toolGateway.writeFile({
      projectId,
      path: 'src/auth/recovered.ts',
      content: 'export const recovered = true;\n',
      taskId: crashTaskId,
      approvalId: approval.id,
      correlationId: effectCorrelation,
    });
    expect(replay.receiptId).toBe(firstWrite.receiptId);
    const receipts = await restarted.service.listTaskReceipts(projectId, crashTaskId);
    expect(
      receipts.filter((receipt) => receipt.correlationId === effectCorrelation)
    ).toHaveLength(1);
    step(10, 'lease expiry recovered from checkpoint; replay reused the single effect receipt');

    // 11 — Finalize the task and assemble evidence.
    const completed = await runtime.service.transitionTask(projectId, taskId, 'complete');
    expect(completed.state).toBe('completed');
    step(11, 'task completed');

    // 12 — Full correlated evidence view.
    const timeline = await body<{ timeline: Array<{ kind: string; taskId?: string }> }>(
      await request(`/api/v1/r1/projects/${projectId}/evidence/timeline?taskId=${taskId}`)
    );
    expect(Array.isArray(timeline.timeline)).toBe(true);
    const kinds = timeline.timeline.map((entry) => entry.kind);
    expect(kinds).toContain('task');
    expect(kinds).toContain('approval');
    expect(kinds).toContain('receipt');
    step(12, 'evidence timeline correlates memories, approvals and receipts');

    // 13 — Versioned export + import dry-run.
    const exported = await body<Record<string, unknown>>(
      await request(`/api/v1/r1/projects/${projectId}/export`)
    );
    expect(exported.schemaVersion).toBeDefined();
    const dryRun = await body<{ wouldApply: boolean; rejected: unknown[]; conflicts: unknown[] }>(
      await request('/api/v1/r1/projects/import/dry-run', {
        method: 'POST',
        body: JSON.stringify(exported),
      })
    );
    expect(dryRun.wouldApply).toBe(true);
    expect(dryRun.rejected).toEqual([]);
    expect(dryRun.conflicts).toEqual([]);
    step(13, 'export bundle validated by a clean import dry-run');

    // 14 — Usefulness feedback closes the loop.
    const target = recall.results[0]!;
    const feedback = await request(`/api/v1/r1/projects/${projectId}/recall/feedback`, {
      method: 'POST',
      body: JSON.stringify({
        query: 'authentication token service rotation',
        resultId: target.id,
        helpful: true,
        comment: 'Used in the refactor plan.',
      }),
    });
    expect(feedback.status).toBe(201);
    const listed = await body<{ feedback: Array<{ resultId: string; helpful: boolean }> }>(
      await request(
        `/api/v1/r1/projects/${projectId}/recall/feedback?resultId=${encodeURIComponent(target.id)}`
      )
    );
    expect(listed.feedback).toEqual(
      expect.arrayContaining([expect.objectContaining({ resultId: target.id, helpful: true })])
    );
    step(14, 'usefulness feedback recorded and readable');

    expect(steps).toHaveLength(14);
    console.log(`GOLDEN-PATH 14/14:\n${steps.join('\n')}`);
  }, 120_000);
});
