/**
 * R1 application contract executed against a real PostgreSQL engine.
 *
 * Closes the PostgreSQL acceptance gap of E1-S2, E3-S1, E4-S1 and E5-S1:
 * the same repository, migration, append-only, idempotency and governed
 * capability/policy contracts that pass on SQLite are executed here on
 * PostgreSQL semantics, using the verbatim production migration files.
 *
 * Engine selection:
 *  - When DATABASE_URL points at a reachable PostgreSQL server the contract
 *    runs against that server (CI/production verification path).
 *  - Otherwise it runs against PGlite, a WASM build of real PostgreSQL
 *    (not an emulation): identical SQL, planner, JSONB, CHECK and PL/pgSQL
 *    trigger semantics, with zero external services required.
 *
 * The contract is re-runnable against a shared PostgreSQL database: every
 * persisted row uses a freshly generated identifier per run, and only rows
 * created by the run are asserted on.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import postgres, { type Sql as PostgresClient } from 'postgres';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  createSqlR1Repositories,
  R1Service,
  SqlCapabilityGovernanceStore,
  type Project,
  type SqlExecutor,
} from '@agentic-os/sdk';
import type { Principal } from '../src/lib/security.js';
import type { NexusEnv } from '../src/lib/hono-env.js';

// The route module imports auth-context, which eagerly initializes the
// application SQLite client. Point it at a scratch location so this contract
// never touches a developer's working database.
process.env.NEXUS_SQLITE_PATH = process.env.NEXUS_SQLITE_PATH
  ?? join(mkdtempSync(join(tmpdir(), 'agentic-r1-pg-sqlite-sidecar-')), 'sidecar.db');

const { createR1Router } = await import('../src/routes/r1.js');
const { createSqlR1Runtime } = await import('../src/services/r1-runtime.js');
const { PGlite } = await import('@electric-sql/pglite');
type PGliteInstance = InstanceType<typeof PGlite>;

interface PostgresHarness {
  readonly engine: 'postgres-server' | 'pglite';
  readonly executor: SqlExecutor;
  exec(statement: string): Promise<void>;
  close(): Promise<void>;
}

function postgresServerHarness(url: string): PostgresHarness {
  const client: PostgresClient = postgres(url, { prepare: false, max: 1 });
  return {
    engine: 'postgres-server',
    executor: {
      async query<T extends object>(statement: string, parameters: readonly unknown[] = []): Promise<readonly T[]> {
        return (await client.unsafe(statement, [...parameters] as never[])) as T[];
      },
    },
    exec: async (statement) => { await client.unsafe(statement); },
    close: async () => { await client.end(); },
  };
}

function pgliteHarness(dataDir?: string): PostgresHarness {
  const db: PGliteInstance = dataDir ? new PGlite(dataDir) : new PGlite();
  return {
    engine: 'pglite',
    executor: {
      async query<T extends object>(statement: string, parameters: readonly unknown[] = []): Promise<readonly T[]> {
        return (await db.query<T>(statement, [...parameters])).rows;
      },
    },
    exec: async (statement) => { await db.exec(statement); },
    close: async () => { await db.close(); },
  };
}

function createHarness(dataDir?: string): PostgresHarness {
  const url = (process.env.DATABASE_URL ?? '').trim();
  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) {
    return postgresServerHarness(url);
  }
  return pgliteHarness(dataDir);
}

/**
 * Base `projects` table exactly as the production Drizzle PostgreSQL schema
 * (`server/src/db/schema.ts`) delivers it to `db:push`/`db:migrate`. The
 * production 0049 migration ALTERs this table, so a faithful contract run
 * must provision it first.
 */
const PRODUCTION_PROJECTS_DDL = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'manual',
  status TEXT NOT NULL DEFAULT 'active',
  memory_count INTEGER NOT NULL DEFAULT 0,
  skill_count INTEGER NOT NULL DEFAULT 0,
  token_footprint INTEGER NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS project_name_unique ON projects(name);
`;

// The verbatim production PostgreSQL migrations under contract.
const PRODUCTION_MIGRATIONS = [
  readFileSync(new URL('../src/db/migrations/0049_r1_contracts.sql', import.meta.url), 'utf8'),
  readFileSync(new URL('../src/db/migrations/0050_r1_durable_task_metadata.sql', import.meta.url), 'utf8'),
  readFileSync(new URL('../src/db/migrations/0051_r1_capability_governance.sql', import.meta.url), 'utf8'),
];

async function applyProductionSchema(harness: PostgresHarness): Promise<void> {
  await harness.exec(PRODUCTION_PROJECTS_DDL);
  for (const migration of PRODUCTION_MIGRATIONS) {
    await harness.exec(migration);
  }
}

const timestamp = '2026-07-21T00:00:00.000Z';

function makeProject(): Project {
  return {
    id: randomUUID(),
    name: `pg-contract-${randomUUID()}`,
    mode: 'local',
    scope: { root: '/tmp/pg-contract' },
    idempotencyKey: `pg-contract-${randomUUID()}`,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

describe('R1 PostgreSQL application contract', () => {
  const harnesses: PostgresHarness[] = [];
  const directories: string[] = [];
  let engine: PostgresHarness['engine'];

  beforeAll(() => {
    const probe = createHarness();
    engine = probe.engine;
    harnesses.push(probe);
  });

  afterEach(async () => {
    for (const harness of harnesses.splice(0)) {
      await harness.close();
    }
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('runs the full R1 repository, idempotency and append-only contract on PostgreSQL', async () => {
    const harness = createHarness();
    harnesses.push(harness);
    await applyProductionSchema(harness);
    const repositories = createSqlR1Repositories(harness.executor);
    const service = new R1Service(repositories);

    // Project persistence — including production timestamp normalization.
    const project = makeProject();
    await expect(repositories.projects.create(project)).resolves.toEqual(project);
    await expect(repositories.projects.get(project.id)).resolves.toEqual(project);
    await expect(repositories.projects.list()).resolves.toContainEqual(project);

    // Provenance memory backed by evidence.
    const evidenceId = randomUUID();
    await expect(repositories.evidence.append({
      id: evidenceId, projectId: project.id, kind: 'source', source: 'pg-contract',
      contentHash: 'b'.repeat(64), metadata: {}, createdAt: timestamp,
    })).resolves.toMatchObject({ id: evidenceId, createdAt: timestamp });
    const provenanceMemory = {
      id: randomUUID(), projectId: project.id, content: 'Persisted provenance memory.',
      metadata: { provenance: { type: 'fact' as const, source: 'pg-contract', confidence: 1, lifecycle: 'active' as const, evidenceIds: [evidenceId] } },
      evidenceIds: [evidenceId], createdAt: timestamp, updatedAt: timestamp,
    };
    await expect(service.saveProvenanceMemory(provenanceMemory)).resolves.toEqual(provenanceMemory);
    await expect(repositories.memories.list(project.id)).resolves.toEqual([provenanceMemory]);

    // E2-S1 lifecycle audit (PostgreSQL verification): the service committed a
    // durable memory.save receipt correlated by memory id; archiving the
    // memory drops the row while its memory.archive receipt survives as the
    // lifecycle record. Ordered by operation for determinism.
    await service.archiveMemory(project.id, provenanceMemory.id, 'principal-archive-actor');
    await expect(repositories.memories.get(project.id, provenanceMemory.id)).resolves.toBeNull();
    const lifecycleReceipts = await harness.executor.query<Record<string, unknown>>(
      `SELECT kind, actor, decision, payload FROM r1_action_receipts
       WHERE project_id = $1 AND correlation_id = $2`,
      [project.id, provenanceMemory.id],
    );
    const normalizedLifecycleReceipts = lifecycleReceipts
      .map((receipt) => ({
        ...receipt,
        payload: typeof receipt.payload === 'string' ? JSON.parse(receipt.payload) as Record<string, unknown> : receipt.payload,
      }))
      .sort((left, right) => String((left.payload as Record<string, unknown>).operation)
        .localeCompare(String((right.payload as Record<string, unknown>).operation)));
    expect(normalizedLifecycleReceipts).toEqual([
      {
        kind: 'db_write', actor: 'principal-archive-actor', decision: 'allow',
        payload: { operation: 'memory.archive', memoryId: provenanceMemory.id, lifecycle: 'active' },
      },
      {
        kind: 'db_write', actor: 'pg-contract', decision: 'allow',
        payload: { operation: 'memory.save', memoryId: provenanceMemory.id, lifecycle: 'active' },
      },
    ]);

    // Durable task creation: CHECK constraints, trigger-created event row,
    // and the atomic idempotent upsert all execute on PostgreSQL semantics.
    const task = {
      id: randomUUID(), projectId: project.id, state: 'queued' as const, title: 'original task',
      principalId: 'principal-test', agentId: 'agent-test', goal: 'durable test goal',
      capabilityIds: [], policyVersion: 'r1', inputReference: 'input:test', correlationId: randomUUID(),
      idempotencyKey: `pg-contract-${randomUUID()}`, createdAt: timestamp, updatedAt: timestamp,
    };
    await expect(repositories.tasks.create(task)).resolves.toEqual(task);
    // The production PL/pgSQL trigger committed the 'created' event.
    await expect(repositories.tasks.listEvents(project.id, task.id)).resolves.toEqual([{
      id: `${task.id}:created`, projectId: project.id, taskId: task.id,
      event: 'created', state: 'queued', sequence: 0, createdAt: timestamp,
    }]);
    // Duplicate idempotency-key submission returns the original task unchanged.
    await expect(repositories.tasks.create({
      ...task, id: randomUUID(), title: 'must not replace original',
    })).resolves.toEqual(task);

    // Append-only action receipts: insert works, mutate/delete is rejected by
    // the production PL/pgSQL trigger, not merely by application code.
    const receipt = {
      id: randomUUID(), projectId: project.id, correlationId: task.correlationId,
      kind: 'tool_call' as const, actor: 'pg-contract', decision: 'allow' as const,
      payload: { taskId: task.id, secret: 'opaque-data' }, createdAt: timestamp,
    };
    await expect(repositories.receipts.append(receipt)).resolves.toEqual(receipt);
    await expect(repositories.receipts.listForTask(project.id, task.id)).resolves.toEqual([receipt]);
    await expect(harness.executor.query(
      'UPDATE r1_action_receipts SET actor = $1 WHERE id = $2', ['mutated', receipt.id],
    )).rejects.toThrow('append-only');

    const evidence = {
      id: randomUUID(), projectId: project.id, taskId: task.id, kind: 'provenance' as const,
      source: 'pg-contract', contentHash: 'a'.repeat(64),
      metadata: { sourceId: 'source-1' }, createdAt: timestamp,
    };
    await expect(repositories.evidence.append(evidence)).resolves.toEqual(evidence);
    await expect(
      harness.executor.query('DELETE FROM r1_evidence WHERE id = $1', [evidence.id]),
    ).rejects.toThrow('append-only');

    // Project scope isolation: cross-project access is rejected.
    await expect(repositories.tasks.get(randomUUID(), task.id))
      .rejects.toMatchObject({ code: 'PROJECT_SCOPE_VIOLATION' });
  });

  it('persists and evaluates governed capabilities and the policy API on PostgreSQL', async () => {
    const harness = createHarness();
    harnesses.push(harness);
    await applyProductionSchema(harness);

    // Store-level contract (E4-S1 persistence on PostgreSQL).
    const governance = new SqlCapabilityGovernanceStore(harness.executor);
    const project = makeProject();
    const governedCapability = {
      id: `file.write.${randomUUID()}`, name: 'Write a project file', source: 'native' as const,
      version: '1.0.0', owner: 'pg-contract', inputSchema: { type: 'object' },
      risk: 'high' as const,
      scope: { projectIds: [project.id], agentIds: ['agent-contract'] },
      health: 'healthy' as const, enabled: true,
    };
    await expect(governance.saveCapability(governedCapability)).resolves.toEqual(governedCapability);
    await expect(governance.listCapabilities()).resolves.toContainEqual(governedCapability);
    const policy = {
      version: 'policy-pg-contract',
      rules: [{ id: 'write-approval', capabilityId: governedCapability.id, decision: 'require_approval' as const }],
    };
    await expect(governance.saveActivePolicy(policy)).resolves.toEqual(policy);
    await expect(governance.getActivePolicy()).resolves.toEqual(policy);

    // API-level contract: scope-authorized registration, policy update and
    // evaluation served by the production router over PostgreSQL persistence.
    const principal: Principal = {
      id: 'principal-test', name: 'PG contract principal', keyHash: 'not-used-in-contract-test',
      scopes: ['memory:read', 'memory:write', 'brain:admin'], status: 'active',
    };
    const app = new Hono<NexusEnv>();
    app.use('*', async (c, next) => { c.set('principal', principal); await next(); });
    app.route('/api/v1/r1', createR1Router(createSqlR1Runtime(harness.executor)));

    await app.request('/api/v1/r1/projects', {
      method: 'POST', body: JSON.stringify(project), headers: { 'content-type': 'application/json' },
    }).then((response) => expect(response.status).toBe(201));

    const registered = await app.request('/api/v1/r1/capabilities', {
      method: 'POST', body: JSON.stringify(governedCapability), headers: { 'content-type': 'application/json' },
    });
    expect(registered.status).toBe(201);
    await expect(registered.json()).resolves.toMatchObject({ id: governedCapability.id, enabled: true });

    const updated = await app.request('/api/v1/r1/capability-policy', {
      method: 'PUT', body: JSON.stringify(policy), headers: { 'content-type': 'application/json' },
    });
    expect(updated.status).toBe(200);

    // Matched rule → require_approval with matched rule id and policy version.
    const approvalEvaluation = await app.request('/api/v1/r1/capability-policy/evaluate', {
      method: 'POST',
      body: JSON.stringify({ projectId: project.id, agentId: 'agent-contract', capabilityId: governedCapability.id }),
      headers: { 'content-type': 'application/json' },
    });
    expect(approvalEvaluation.status).toBe(200);
    await expect(approvalEvaluation.json()).resolves.toEqual({
      decision: 'require_approval', policyVersion: policy.version,
      ruleId: 'write-approval', reason: 'Matched application policy rule.',
    });

    // Unregistered capability → deterministic default-deny.
    const unregistered = await app.request('/api/v1/r1/capability-policy/evaluate', {
      method: 'POST',
      body: JSON.stringify({ projectId: project.id, agentId: 'agent-contract', capabilityId: 'does.not.exist' }),
      headers: { 'content-type': 'application/json' },
    });
    await expect(unregistered.json()).resolves.toMatchObject({ decision: 'deny', ruleId: 'default-deny' });

    // Scope escalation: valid capability, agent outside the allowlist → deny.
    const escalated = await app.request('/api/v1/r1/capability-policy/evaluate', {
      method: 'POST',
      body: JSON.stringify({ projectId: project.id, agentId: 'rogue-agent', capabilityId: governedCapability.id }),
      headers: { 'content-type': 'application/json' },
    });
    await expect(escalated.json()).resolves.toMatchObject({ decision: 'deny', ruleId: 'default-deny' });

    // Authentication enforcement: no principal is rejected before persistence.
    const anonymous = new Hono<NexusEnv>();
    anonymous.use('*', async (c, next) => { await next(); });
    anonymous.route('/api/v1/r1', createR1Router(createSqlR1Runtime(harness.executor)));
    const rejected = await anonymous.request('/api/v1/r1/capabilities', {
      method: 'POST', body: JSON.stringify(governedCapability), headers: { 'content-type': 'application/json' },
    });
    expect(rejected.status).toBe(401);
  });

  it('preserves committed project and task state across an engine restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agentic-r1-pg-restart-'));
    directories.push(directory);

    const project = makeProject();
    const task = {
      id: randomUUID(), projectId: project.id, state: 'queued' as const, title: 'durable pg task',
      principalId: 'principal-test', agentId: 'agent-test', goal: 'durable test goal',
      capabilityIds: [], policyVersion: 'r1', inputReference: 'input:test', correlationId: randomUUID(),
      idempotencyKey: `pg-contract-${randomUUID()}`, createdAt: timestamp, updatedAt: timestamp,
    };

    const first = createHarness(engine === 'pglite' ? join(directory, 'pgdata') : undefined);
    harnesses.push(first);
    await applyProductionSchema(first);
    const firstRepositories = createSqlR1Repositories(first.executor);
    await firstRepositories.projects.create(project);
    await firstRepositories.tasks.create(task);
    await first.close();
    harnesses.splice(harnesses.indexOf(first), 1);

    // A fresh engine instance (or a fresh connection for a server-backed run)
    // must observe the committed rows without re-running migrations.
    const restarted = createHarness(engine === 'pglite' ? join(directory, 'pgdata') : undefined);
    harnesses.push(restarted);
    const restartedRepositories = createSqlR1Repositories(restarted.executor);
    await expect(restartedRepositories.projects.get(project.id)).resolves.toEqual(project);
    await expect(restartedRepositories.tasks.get(project.id, task.id)).resolves.toEqual(task);
  });
});
