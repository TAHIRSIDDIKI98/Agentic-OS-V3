/**
 * Regression tests for the SQLite write paths behind the MCP tools.
 *
 * Baseline evidence (Phase 0 MCP smoke test):
 *   nexus_delegate      → NOT NULL constraint failed: agents.token_budget
 *   nexus_cron_create   → Too few parameter values were provided
 *   nexus_ambient_ingest→ Too few parameter values were provided
 *
 * Root cause: the SQLite schema declares JSON-shaped columns as plain `text()`,
 * so drizzle passes raw JS objects/arrays to better-sqlite3, which mis-binds
 * positional parameters. The schema file is frozen, so these writers must
 * serialize the JSON payload themselves.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const directories: string[] = [];
let previousSqlitePath: string | undefined;

beforeEach(() => {
  previousSqlitePath = process.env.NEXUS_SQLITE_PATH;
  vi.resetModules();
  const directory = mkdtempSync(join(tmpdir(), 'nexus-sqlite-writes-'));
  directories.push(directory);
  process.env.NEXUS_SQLITE_PATH = join(directory, 'writes.db');
  delete process.env.DATABASE_URL;
  // PORT=0 is exported by some runners; the frozen env schema rejects it.
  process.env.PORT = '9900';
  delete process.env.NEXUS_LLM_API_KEY;
  delete process.env.NEXUS_LLM_BASE_URL;
  delete process.env.NEXUS_LLM_MODEL;
});

afterEach(async () => {
  // Close the singleton connection BEFORE resetting the module registry,
  // otherwise Windows keeps the file locked and cleanup fails.
  try {
    const { closeDb } = await import('../src/db/client.js');
    await closeDb();
  } catch {
    /* never opened, or already closed */
  }
  vi.resetModules();
  if (previousSqlitePath === undefined) delete process.env.NEXUS_SQLITE_PATH;
  else process.env.NEXUS_SQLITE_PATH = previousSqlitePath;
  for (const directory of directories.splice(0)) {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      /* Windows may hold the handle briefly */
    }
  }
});

describe('SQLite write paths used by MCP tools', () => {
  it('spawns an agent (nexus_delegate)', async () => {
    const { spawnAgent } = await import('../src/services/kernel.js');

    const agent = await spawnAgent(
      { name: 'test-subagent', kind: 'sub-agent', ring: 2, scopes: ['memory:read'] },
      'test'
    );

    expect(agent?.id).toMatch(/^agt_/);
    expect(agent?.tokenBudget).toBe(100000);
    // SQLite stores the JSON payload as text (see schema-sqlite.ts).
    expect(JSON.parse(String(agent?.scopes))).toEqual(['memory:read']);
  });

  it('enqueues a task with a structured input payload', async () => {
    const { spawnAgent, enqueueTask } = await import('../src/services/kernel.js');
    const agent = await spawnAgent({ name: 'task-owner', kind: 'sub-agent' }, 'test');

    const task = await enqueueTask(
      {
        agentId: agent!.id,
        label: 'structured input',
        kind: 'background',
        input: { nested: { deep: [1, 2, 3] }, flag: true },
      },
      'test'
    );

    expect(task?.id).toMatch(/^tsk_/);
    expect(JSON.parse(String(task?.input))).toEqual({ nested: { deep: [1, 2, 3] }, flag: true });
  });

  it('creates a cron job (nexus_cron_create)', async () => {
    const { createCronJob, listCronJobs } = await import('../src/services/operations-ext.js');

    const job = await createCronJob(
      { name: 'nightly', cron: '*/5 * * * *', taskLabel: 'nightly tick' },
      'test'
    );

    expect(job?.id).toMatch(/^crn_/);
    expect(JSON.parse(String(job?.taskInput))).toEqual({});
    expect(await listCronJobs()).toHaveLength(1);
  });

  it('ingests an ambient transcript (nexus_ambient_ingest)', async () => {
    const { ingestAmbientTranscript } = await import('../src/services/operations-ext.js');

    const result = await ingestAmbientTranscript(
      'Ambient note: pin the base image to node:22-alpine.',
      'test',
      {},
      'test'
    );

    expect(result.taskId).toMatch(/^tsk_/);
    expect(result.agentId).toMatch(/^agt_/);
  });

  it('invalidates the cached brain stats after a memory write', async () => {
    const { statsCache } = await import('../src/lib/lru-cache.js');
    const { createMemory } = await import('../src/services/memory.service.js');

    statsCache.set('stats', { memories: 0 });
    await createMemory(
      {
        kind: 'fact',
        title: 'Cache invalidation',
        content: 'Writing a memory must invalidate the cached stats snapshot.',
        tags: [],
        importance: 0.5,
        source: 'test',
        projectId: null,
      },
      'test'
    );

    expect(statsCache.get('stats')).toBeUndefined();
  });
});
