/**
 * Regression tests for hash-chain verification in SQLite mode.
 *
 * Baseline evidence (Phase 0 MCP smoke test): a fresh one-entry chain reported
 *   {"valid":false,"verifiedEntries":0,"brokenAt":1,"total":0}
 * because the writer hashed the payload object while the verifier re-hashed the
 * JSON string that SQLite stored.
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
  const directory = mkdtempSync(join(tmpdir(), 'nexus-audit-'));
  directories.push(directory);
  process.env.NEXUS_SQLITE_PATH = join(directory, 'audit.db');
  delete process.env.DATABASE_URL;
  process.env.PORT = '9900';
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

describe('audit chain on SQLite', () => {
  it('verifies a chain of object-payload entries', async () => {
    const { appendAudit, verifyAuditChain } = await import('../src/lib/audit.js');

    await appendAudit('test.first', { nested: { a: 1 }, list: [1, 2] }, 'tester');
    await appendAudit('test.second', { plain: 'value' }, 'tester');
    await appendAudit('test.third', { empty: {} }, 'tester');

    const result = await verifyAuditChain();
    expect(result.valid).toBe(true);
    expect(result.verifiedEntries).toBe(3);
    expect(result.total).toBe(3);
    expect(result.brokenAt).toBeNull();
  });

  it('detects a tampered payload', async () => {
    const { appendAudit, verifyAuditChain } = await import('../src/lib/audit.js');
    const { db, auditLog } = await import('../src/db/client.js');
    const { eq } = await import('drizzle-orm');

    await appendAudit('test.first', { amount: 1 }, 'tester');
    await appendAudit('test.second', { amount: 2 }, 'tester');
    await appendAudit('test.third', { amount: 3 }, 'tester');

    await db
      .update(auditLog)
      .set({ payload: JSON.stringify({ amount: 999 }) })
      .where(eq(auditLog.sequence, 2));

    const result = await verifyAuditChain();
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(2);
  });

  it('serializes concurrent appends so sequence numbers never collide', async () => {
    const { appendAudit, verifyAuditChain } = await import('../src/lib/audit.js');

    // The server appends from the task worker, the audit watchdog and MCP calls
    // at the same time; a read-then-insert of the chain tip must be serialized.
    await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        appendAudit(`test.concurrent.${index}`, { index }, 'tester')
      )
    );

    const result = await verifyAuditChain();
    expect(result.valid).toBe(true);
    expect(result.total).toBe(10);
  });

  it('keeps string payloads stable across a write/verify round trip', async () => {
    const { appendAudit, verifyAuditChain } = await import('../src/lib/audit.js');

    await appendAudit('test.string', '{"looks":"like json"}', 'tester');

    const result = await verifyAuditChain();
    expect(result.valid).toBe(true);
  });
});
