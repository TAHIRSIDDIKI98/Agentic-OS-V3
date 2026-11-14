/**
 * Regression tests for the "never lose a transcript" invariant.
 *
 * Baseline evidence (Phase 0 MCP smoke test), no LLM configured:
 *   nexus_capture → {"distilled":true,"transcriptPreserved":false}
 *
 * The raw transcript must always be persisted before distillation, and a
 * declarative fact stated in the transcript must survive as a durable,
 * recallable fact — not as a 600-character "Session summary".
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const directories: string[] = [];
let previousSqlitePath: string | undefined;
const TRANSCRIPT = [
  'User: how should we ship this service?',
  'Assistant: we deploy with docker compose on port 8080, and the reverse proxy handles TLS.',
  'User: good. Keep the compose file in the repo root.',
  'Assistant: noted — the staging database is postgres 17 with pgvector enabled.',
].join('\n');

beforeEach(() => {
  previousSqlitePath = process.env.NEXUS_SQLITE_PATH;
  vi.resetModules();
  const directory = mkdtempSync(join(tmpdir(), 'nexus-capture-'));
  directories.push(directory);
  process.env.NEXUS_SQLITE_PATH = join(directory, 'capture.db');
  delete process.env.DATABASE_URL;
  process.env.PORT = '9900';
  // No LLM: the heuristic fallback must carry the load.
  delete process.env.NEXUS_LLM_API_KEY;
  delete process.env.NEXUS_LLM_BASE_URL;
  delete process.env.NEXUS_LLM_MODEL;
});

afterEach(async () => {
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

describe('session capture preserves the transcript', () => {
  it('persists the full raw transcript and reports it', async () => {
    const { captureSession } = await import('../src/services/memory.service.js');
    const { db, memories } = await import('../src/db/client.js');
    const { eq } = await import('drizzle-orm');

    const report = await captureSession(TRANSCRIPT, undefined, 'test');

    expect(report.transcriptPreserved).toBe(true);

    const rawRows = await db.select().from(memories).where(eq(memories.source, 'session-raw'));
    expect(rawRows).toHaveLength(1);
    // The invariant is the WHOLE transcript, not a 600-character excerpt.
    expect(rawRows[0]!.content).toBe(TRANSCRIPT);
    expect(rawRows[0]!.content.length).toBe(TRANSCRIPT.length);
  });

  it('extracts a declarative fact without an LLM', async () => {
    const { captureSession } = await import('../src/services/memory.service.js');

    const report = await captureSession(TRANSCRIPT, undefined, 'test');
    expect(report.distilled).toBe(true);

    const { db, memories } = await import('../src/db/client.js');
    const rows = await db.select().from(memories);
    // The raw transcript row also contains the sentence: assert on the
    // DISTILLED row, which is the one that must be typed as a fact.
    const fact = rows.find(
      (row: { content: string; source: string }) =>
        row.source !== 'session-raw' && /docker compose on port 8080/i.test(row.content)
    );

    expect(fact).toBeDefined();
    expect(fact!.kind).toBe('fact');
    expect(String(fact!.content)).not.toContain('User:');
  });

  it('makes the captured fact recallable', async () => {
    const { captureSession } = await import('../src/services/memory.service.js');
    const { recall } = await import('../src/services/recall.js');

    await captureSession(TRANSCRIPT, undefined, 'test');

    const result = await recall('how do we deploy', 1500, 'test');
    const text = JSON.stringify(result);
    expect(text).toMatch(/docker compose/i);
  });

  it('records which agent/client produced the session', async () => {
    const { captureSession } = await import('../src/services/memory.service.js');
    const { db, memories } = await import('../src/db/client.js');

    await captureSession(TRANSCRIPT, undefined, 'test', false, 'claude-code');

    const rows = await db.select().from(memories);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(String(row.source)).toContain('claude-code');
      const tags = Array.isArray(row.tags) ? (row.tags as string[]) : (JSON.parse(String(row.tags)) as string[]);
      if (String(row.source).startsWith('session-raw')) {
        expect(tags).toContain('client:claude-code');
      }
    }
  });

  it('keeps the raw transcript when distillation fails', async () => {
    const { captureSession } = await import('../src/services/memory.service.js');
    const { db, memories } = await import('../src/db/client.js');
    const { eq } = await import('drizzle-orm');

    const report = await captureSession(TRANSCRIPT, undefined, 'test', true);

    expect(report.distilled).toBe(false);
    expect(report.transcriptPreserved).toBe(true);
    expect(report.reason).toBeTruthy();
    const rawRows = await db.select().from(memories).where(eq(memories.source, 'session-raw'));
    expect(rawRows).toHaveLength(1);
    expect(rawRows[0]!.content).toBe(TRANSCRIPT);
  });
});
