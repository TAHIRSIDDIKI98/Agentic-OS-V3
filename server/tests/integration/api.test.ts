/**
 * Integration tests — HTTP-level against the fully assembled app + a real
 * Postgres test database. These FAIL LOUDLY (exit non-zero) if the test DB is
 * unreachable — they never report green by running zero assertions.
 *
 * Run `npm run db:push` against DATABASE_URL first, then `npm run test:integration`.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { db, closeDb } from '../../src/db/client.js';
import { createApp } from '../../src/app.js';
import { apiKeys, memories } from '../../src/db/schema.js';
import { hashApiKey, generateApiKey, invalidateAuthCache } from '../../src/lib/security.js';
import { randomUUID } from 'node:crypto';

let operatorKey = '';
let operatorId = '';

// The fully assembled app (perimeter + routes + 404 guard + fallback), so the
// whole perimeter — including the API-404 guard — is exercised by these tests.
const app = createApp();

async function ensureDb(): Promise<void> {
  const isSqliteBackend =
    !process.env.DATABASE_URL ||
    (!process.env.DATABASE_URL.startsWith('postgres://') &&
      !process.env.DATABASE_URL.startsWith('postgresql://'));
  if (isSqliteBackend) {
    throw new Error(
      '[INTEGRATION] SQLite active. Integration tests require PostgreSQL database. Set DATABASE_URL to a test Postgres, run `npm run db:push`, then `npm run test:integration`.'
    );
  }
  try {
    await db.execute('SELECT 1');
    // Provision a test principal.
    operatorKey = generateApiKey();
    operatorId = `prn_${randomUUID()}`;
    await db.delete(apiKeys);
    await db.insert(apiKeys).values({
      id: operatorId,
      name: 'operator',
      keyHash: hashApiKey(operatorKey),
      scopes: [
        'memory:read',
        'memory:write',
        'skill:read',
        'skill:write',
        'brain:admin',
        'vault:read',
        'vault:write',
        'safety:write',
        'audit:read',
      ],
      status: 'active',
    });
    await db.delete(memories);
  } catch (e) {
    // Fail loudly — integration tests must NEVER report green by running zero
    // assertions. If there's no reachable Postgres, the suite exits non-zero.
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      '[INTEGRATION] Cannot connect to the test database. Set DATABASE_URL to a ' +
        'test Postgres, run `npm run db:push`, then `npm run test:integration`. ' +
        `Underlying error: ${msg}`
    );
  }
}

beforeAll(async () => {
  await ensureDb();
  return async () => {
    await closeDb();
  };
});

describe('API integration', () => {
  it('health is public', async () => {
    const res = await app.request('/api/v1/health');
    expect(res.status).toBe(200);
  });

  it('mutations require auth', async () => {
    const res = await app.request('/api/v1/memories', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'x', content: 'y' }),
    });
    expect(res.status).toBe(401);
  });

  it('sensitive reads require auth', async () => {
    const res = await app.request('/api/v1/audit');
    expect(res.status).toBe(401);
    const res2 = await app.request('/api/v1/brain/export');
    expect(res2.status).toBe(401);
  });

  it('create + recall round trip', async () => {
    const create = await app.request('/api/v1/memories', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${operatorKey}` },
      body: JSON.stringify({
        kind: 'fact',
        title: 'Integration fact about pooling',
        content: 'Connection pooling bounds DB load.',
        importance: 0.9,
      }),
    });
    expect(create.status).toBe(201);

    const rec = await app.request('/api/v1/recall?q=connection%20pooling&budget=1000', {
      headers: { authorization: `Bearer ${operatorKey}` },
    });
    expect(rec.status).toBe(200);
    const body = (await rec.json()) as { data: { returned: unknown[]; tokensUsed: number } };
    expect(body.data.returned.length).toBeGreaterThan(0);
    expect(body.data.tokensUsed).toBeLessThanOrEqual(1000);
  });

  it('never loses transcript on capture failure', async () => {
    const res = await app.request('/api/v1/sessions/capture', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${operatorKey}` },
      body: JSON.stringify({
        transcript: 'CRITICAL UNIQUE TRANSCRIPT STRING 90210',
        projectName: 't',
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { transcript: string } };
    expect(body.data.transcript).toContain('CRITICAL UNIQUE TRANSCRIPT STRING 90210');
  });

  it('oversized payload is rejected', async () => {
    // Cross the configured 5 MiB limit by one byte and report the exact wire
    // length so the perimeter can reject from Content-Length without buffering
    // a needlessly large body in the integration runner.
    const big = 'x'.repeat(5 * 1024 * 1024 + 1);
    const payload = JSON.stringify({ title: 'x', content: big });
    const res = await app.request('/api/v1/memories', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${operatorKey}`,
        'content-length': String(Buffer.byteLength(payload)),
      },
      body: payload,
    });
    expect([413, 400]).toContain(res.status);
  });

  it('audit chain verifies', async () => {
    const res = await app.request('/api/v1/audit', {
      headers: { authorization: `Bearer ${operatorKey}` },
    });
    const body = (await res.json()) as { data: { valid: boolean } };
    expect(body.data.valid).toBe(true);
  });

  it('brain export then import round-trips (idempotent)', async () => {
    // Export current brain.
    const exp = await app.request('/api/v1/brain/export', {
      headers: { authorization: `Bearer ${operatorKey}` },
    });
    const exported = await exp.json();
    expect((exported as { ok: boolean }).ok).toBe(true);
    // Import it back — should be all duplicates.
    const imp = await app.request('/api/v1/brain/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${operatorKey}` },
      body: JSON.stringify((exported as { data: unknown }).data),
    });
    const imported = await imp.json();
    expect(imp.status).toBe(201);
    expect((imported as { data: { duplicates: number } }).data.duplicates).toBeGreaterThan(0);
  });

  it('brain import rejects invalid schema', async () => {
    const res = await app.request('/api/v1/brain/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${operatorKey}` },
      body: JSON.stringify({ format: 'not-nexus', garbage: true }),
    });
    expect(res.status).toBe(400);
  });

  it('project transfer creates memories + skills', async () => {
    const res = await app.request('/api/v1/projects/transfer', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${operatorKey}` },
      body: JSON.stringify({
        projectName: 'legacy-app',
        memories: [{ kind: 'fact', title: 'Pool max', content: 'Connection pool max is 20.' }],
        skills: [
          { name: 'deploy', title: 'Deploy', description: 'd', content: 'c', category: 'ops' },
        ],
      }),
    });
    const body = await res.json();
    expect(res.status).toBe(201);
    const body2 = body as { data: { memCreated: number; sklUpserted: number } };
    expect(body2.data.memCreated).toBe(1);
    expect(body2.data.sklUpserted).toBe(1);
  });

  it('kill switch blocks mutations', async () => {
    const engage = await app.request('/api/v1/safety/kill-switch', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${operatorKey}` },
      body: JSON.stringify({ enabled: true, reason: 'test' }),
    });
    expect(engage.status).toBe(200);

    const blocked = await app.request('/api/v1/memories', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${operatorKey}` },
      body: JSON.stringify({ title: 'x', content: 'y' }),
    });
    expect(blocked.status).toBe(423);

    // Release for subsequent tests.
    await app.request('/api/v1/safety/kill-switch', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${operatorKey}` },
      body: JSON.stringify({ enabled: false }),
    });
  });

  it('unmatched /api/* returns a JSON 404 envelope, not the SPA', async () => {
    const res = await app.request('/api/v1/does-not-exist', {
      headers: { authorization: `Bearer ${operatorKey}` },
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    const body3 = body as { ok: boolean; error: { code: string } };
    expect(body3.ok).toBe(false);
    expect(body3.error.code).toBe('NOT_FOUND');
    // Must be JSON, not HTML.
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('scopes are enforced (read-only key cannot write)', async () => {
    // Provision a read-only principal.
    const roKey = generateApiKey();
    await db.insert(apiKeys).values({
      id: `prn_${randomUUID()}`,
      name: 'reader',
      keyHash: hashApiKey(roKey),
      scopes: ['memory:read'],
      status: 'active',
    });
    // Invalidate auth cache so the new key is picked up
    invalidateAuthCache();
    const res = await app.request('/api/v1/memories', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${roKey}` },
      body: JSON.stringify({ title: 'x', content: 'y' }),
    });
    expect(res.status).toBe(403);
  });
});
