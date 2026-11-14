/**
 * Regression tests for principal scopes on SQLite (Phase 2 first-run bug).
 *
 * SQLite keeps `api_keys.scopes` as JSON text while Postgres returns jsonb.
 * Writing an array crashed with "Too many parameter values were provided", and
 * reading it back left `hasScope` iterating a string, which silently disabled
 * wildcard grants.
 */
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { apiKeys, db, isSqlite } from '../src/db/client.js';
import {
  authenticate,
  createPrincipal,
  hasScope,
  hashApiKey,
  invalidateAuthCache,
  listPrincipals,
  type Scope,
} from '../src/lib/security.js';

function uniqueName(prefix: string): string {
  return `${prefix}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
}

describe('principal scopes on SQLite', () => {
  it('mints a key and authorizes only the granted scopes', async () => {
    const name = uniqueName('agent:test');
    const created = await createPrincipal(db, name, ['memory:read', 'skill:read']);

    expect(created.id).toMatch(/^prn_/);
    invalidateAuthCache();

    const principal = await authenticate(db, created.rawKey);
    expect(principal).not.toBeNull();
    expect(principal!.name).toBe(name);
    expect(principal!.scopes).toEqual(['memory:read', 'skill:read']);

    expect(hasScope(principal, 'memory:read')).toBe(true);
    expect(hasScope(principal, 'skill:read')).toBe(true);
    expect(hasScope(principal, 'memory:write')).toBe(false);
    expect(hasScope(principal, 'audit:read')).toBe(false);
    expect(hasScope(principal, 'brain:admin')).toBe(false);
  });

  it('stores scopes as JSON text on SQLite and as an array elsewhere', async () => {
    const created = await createPrincipal(db, uniqueName('agent:format'), ['memory:read']);
    const rows = await db.select().from(apiKeys).where(eq(apiKeys.id, created.id));
    const raw = rows[0]!.scopes;

    if (isSqlite) {
      expect(typeof raw).toBe('string');
      expect(parseRaw(raw)).toEqual(['memory:read']);
    } else {
      expect(raw).toEqual(['memory:read']);
    }
  });

  it('honors wildcard families', async () => {
    const created = await createPrincipal(db, uniqueName('agent:wild'), ['memory.*' as Scope]);
    invalidateAuthCache();
    const principal = await authenticate(db, created.rawKey);

    expect(hasScope(principal, 'memory:read')).toBe(true);
    expect(hasScope(principal, 'memory:write')).toBe(true);
    expect(hasScope(principal, 'audit:read')).toBe(false);
  });

  it('treats malformed stored scopes as no grants instead of crashing auth', async () => {
    const rawKey = 'nx_malformed_scope_key_0123456789';
    await db.insert(apiKeys).values({
      id: uniqueName('prn_bad'),
      name: uniqueName('agent:bad'),
      keyHash: hashApiKey(rawKey),
      // Legacy/corrupt value: must not throw and must not grant anything.
      scopes: 'not-json' as unknown as string,
      status: 'active',
    });
    invalidateAuthCache();

    const principal = await authenticate(db, rawKey);
    expect(principal).not.toBeNull();
    expect(principal!.scopes).toEqual([]);
    expect(hasScope(principal, 'memory:read')).toBe(false);
  });

  it('lists principals with parsed scopes', async () => {
    const created = await createPrincipal(db, uniqueName('agent:list'), ['memory:read']);
    const { items } = await listPrincipals(db, { limit: 200 });
    const found = items.find((item) => item.id === created.id);

    expect(found).toBeDefined();
    expect(Array.isArray(found!.scopes)).toBe(true);
    expect(found!.scopes).toContain('memory:read');
  });
});

function parseRaw(raw: unknown): unknown {
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}
