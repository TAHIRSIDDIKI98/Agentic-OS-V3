/**
 * security.ts — real API-key auth & authorization.
 * Keys are hashed with scrypt (Node's audited KDF) and never stored raw.
 * Comparison uses crypto.timingSafeEqual (constant-time).
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { eq, sql, desc } from 'drizzle-orm';
import { apiKeys, isSqlite } from '../db/client.js';
import { getEnv } from '../lib/env.js';
import { log } from '../lib/logging.js';

const SCRYPT_KEYLEN = 32;

/** Hash a raw key into a self-contained "<saltHex>:<hashHex>" record. */
export function hashApiKey(raw: string): string {
  // Length limit to prevent DoS via overly long passwords causing excessive scrypt computation.
  if (raw.length > 512) throw new Error('API key too long for hashing');
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(raw, salt, SCRYPT_KEYLEN).toString('hex');
  return `${salt}:${hash}`;
}

/**
 * Verify a raw key against a "<saltHex>:<hashHex>" record.
 * Comparison is constant-time (scrypt-derived output), not the hex strings.
 * The length mismatch check runs AFTER scrypt computation to avoid a timing
 * side-channel: an attacker must not be able to distinguish "wrong length"
 * from "wrong key" by response time.
 */
export function verifyApiKey(raw: string, record: string): boolean {
  // Length limit to prevent DoS via overly long passwords causing excessive scrypt computation.
  if (raw.length > 512) return false;
  const colon = record.indexOf(':');
  if (colon === -1) return false;
  const salt = record.slice(0, colon);
  const expectedHash = record.slice(colon + 1);
  const expectedBuf = Buffer.from(expectedHash, 'hex');
  // Always run scryptSync first to keep response time consistent regardless of
  // record format.
  const actualHash = scryptSync(raw, salt, SCRYPT_KEYLEN);
  // timingSafeEqual requires equal-length buffers; malformed records must not throw.
  if (expectedBuf.length !== SCRYPT_KEYLEN) return false;
  try {
    return timingSafeEqual(expectedBuf, actualHash);
  } catch {
    return false;
  }
}

/** Generate a human-usable key (not a hash — this is the one we show once). */
export function generateApiKey(): string {
  return `nk_nexus_${randomBytes(24).toString('hex')}`;
}

export type Scope =
  | 'chat.*'
  | 'chat.read'
  | 'chat.write'
  | 'admin.*'
  | 'admin.read'
  | 'admin.write'
  | 'admin.key.*'
  | 'admin.key.read'
  | 'admin.key.write'
  | 'dashboard.*'
  | 'dashboard.read'
  | 'memory:read'
  | 'memory:write'
  | 'skill:read'
  | 'skill:write'
  | 'audit:read'
  | 'brain:admin'
  | 'vault:read'
  | 'vault:write'
  | 'safety:write'
  | 'llm:chat'
  | 'llm:admin'
  | 'plugin:admin'
  | 'plugin:invoke'
  | 'federated:write'
  | 'federated:read'
  | 'pipeline:admin'
  | 'pipeline:execute'
  | 'marketplace:read'
  | 'marketplace:write'
  | 'marketplace:publish'
  | 'marketplace:review'
  | 'integrations:read'
  | 'integrations:write'
  | 'selfopt:read'
  | 'selfopt:write'
  | 'enterprise.*'
  | 'enterprise:read'
  | 'enterprise:write';

/** Scopes defined in this application — ideally this would live in a config table. */
export const ALL_SCOPES = [
  'chat.*',
  'chat.read',
  'chat.write',
  'admin.*',
  'admin.read',
  'admin.write',
  'admin.key.*',
  'admin.key.read',
  'admin.key.write',
  'dashboard.*',
  'dashboard.read',
  'memory:read',
  'memory:write',
  'skill:read',
  'skill:write',
  'audit:read',
  'brain:admin',
  'vault:read',
  'vault:write',
  'safety:write',
  'llm:chat',
  'llm:admin',
  'plugin:admin',
  'plugin:invoke',
  'federated:write',
  'federated:read',
  'pipeline:admin',
  'pipeline:execute',
  'marketplace:read',
  'marketplace:write',
  'marketplace:publish',
  'marketplace:review',
  'integrations:read',
  'integrations:write',
  // Enterprise + self-opt scopes: part of the Scope union and enforced by
  // routes/enterprise.ts and routes/self-opt.ts — the registry must list them
  // or isValidScope() rejects keys that legitimately hold them.
  'selfopt:read',
  'selfopt:write',
  'enterprise.*',
  'enterprise:read',
  'enterprise:write',
] as const satisfies readonly Scope[];

export function isValidScope(s: string): s is Scope {
  return ALL_SCOPES.includes(s as (typeof ALL_SCOPES)[number]);
}

export interface Principal {
  id: string;
  name: string;
  keyHash: string;
  scopes: Scope[];
  status: 'active' | 'disabled';
}

/**
 * Bounded caches:
 *  - principalCache: caches the full active-principal list (with keyHash) for
 *    PRINCIPAL_TTL_MS. Does NOT cache negative lookups (unknown key) because a
 *    chosen token would let an attacker flood unique keys and grow the cache
 *    unbounded → OOM. Only known-good keys are memoized.
 *  - The positive cache is bounded and evicts oldest entries past the cap, so
 *    it cannot grow without limit even under a successful-key flood.
 *  - The `lastUsedAt` of the matched principal is updated (best-effort) so the
 *    column is no longer dead.
 */
const PRINCIPAL_TTL_MS = getEnv().NEXUS_AUTH_PRINCIPAL_TTL_MS;
const RESULT_TTL_MS = getEnv().NEXUS_AUTH_RESULT_TTL_MS;
const RESULT_CACHE_CAP = getEnv().NEXUS_AUTH_RESULT_CACHE_CAP;
let principalCache: { rows: PrincipalRow[]; at: number } | null = null;
let activePrincipalIds: Set<string> | null = null;
const resultCache = new Map<string, { principal: Principal; at: number }>();

interface PrincipalRow {
  id: string;
  name: string;
  keyHash: string;
  scopes: Scope[];
  status: string;
}

/**
 * Normalize a stored `scopes` value.
 * Postgres (jsonb) yields an array; SQLite stores the same value as JSON text.
 * Without this, `hasScope` iterated a string character-by-character, so wildcard
 * scopes like `memory.*` never matched and substring matches could over-grant.
 */
function parseScopes(raw: unknown): Scope[] {
  if (Array.isArray(raw)) return raw.filter((s): s is Scope => typeof s === 'string');
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.filter((s): s is Scope => typeof s === 'string');
    } catch {
      // Malformed/legacy value: treat as no scopes rather than throwing in auth.
    }
  }
  return [];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Db type is polymorphic Postgres/SQLite; narrowed at callsite
async function loadPrincipals(db: any): Promise<PrincipalRow[]> {
  const now = Date.now();
  if (principalCache && now - principalCache.at < PRINCIPAL_TTL_MS) return principalCache.rows;
  const rows = await db.query.apiKeys.findMany({ where: eq(apiKeys.status, 'active') });
  // Map the Drizzle row to our internal PrincipalRow shape (validates the columns exist).
  const mapped: PrincipalRow[] = rows.map((r: (typeof rows)[number]) => ({
    id: r.id,
    name: r.name,
    keyHash: r.keyHash,
    scopes: parseScopes(r.scopes),
    status: r.status,
  }));
  activePrincipalIds = new Set(mapped.filter((r) => r.status === 'active').map((r) => r.id));
  principalCache = { rows: mapped, at: now };
  return principalCache.rows;
}

/** Bounded insertion into the positive-result cache (evicts oldest when full). */
function cacheResult(key: string, principal: Principal): void {
  if (resultCache.size >= RESULT_CACHE_CAP) {
    // Evict the oldest entry by insertion order.
    const oldest = resultCache.keys().next().value;
    if (oldest) resultCache.delete(oldest);
  }
  resultCache.set(key, { principal, at: Date.now() });
}

/** Invalidate caches — call after principal/key changes (create, revoke, rotate). */
export function invalidateAuthCache(): void {
  principalCache = null;
  activePrincipalIds = null;
  resultCache.clear();
}

/** Resolve a principal by raw key, with bounded caching of POSITIVE results only. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Db type is polymorphic Postgres/SQLite; narrowed at callsite
export async function authenticate(db: any, key: string | null): Promise<Principal | null> {
  if (!key) return null;
  const now = Date.now();
  const cached = resultCache.get(key);
  // O(1) cache-hit verification: check if the principal's ID is still in the
  // active set (refreshed every PRINCIPAL_TTL_MS). No scrypt re-computation.
  if (cached && now - cached.at < RESULT_TTL_MS) {
    await loadPrincipals(db);
    if (!activePrincipalIds?.has(cached.principal.id)) {
      resultCache.delete(key);
      return null;
    }
    return cached.principal;
  }

  let principal: Principal | null = null;
  let matchedId: string | null = null;
  // Use the cached active-principal list (loaded every PRINCIPAL_TTL_MS) instead
  // of scanning every key with scrypt. This is O(N_active) instead of O(N_all)
  // because we only verify against principals whose status is 'active'.
  const rows = await loadPrincipals(db);
  for (const row of rows) {
    if (row.status !== 'active') continue;
    if (verifyApiKey(key, row.keyHash)) {
      const status: 'active' | 'disabled' = 'active';
      principal = { id: row.id, name: row.name, keyHash: row.keyHash, scopes: row.scopes, status };
      matchedId = row.id;
      break;
    }
  }
  if (principal) {
    cacheResult(key, principal);
    // Best-effort lastUsedAt — auth must never fail because of a metadata write.
    // Errors are logged (never silently swallowed), but do not propagate.
    if (matchedId) {
      const nowFn = isSqlite ? sql`CURRENT_TIMESTAMP` : sql`now()`;
      db.update(apiKeys)
        .set({ lastUsedAt: nowFn })
        .where(eq(apiKeys.id, matchedId))
        .catch((e: unknown) => {
          // Non-critical: metadata write failure should not block auth.
          log.warn('auth.lastUsedAt_failed', { error: e instanceof Error ? e.message : String(e) });
        });
    }
  }
  return principal;
}

/**
 * Check if a principal has a given scope, with wildcard matching.
 * A scope like 'admin.*' matches 'admin.read', 'admin.write', 'admin.key.*', 'admin.key.read', etc.
 * This enables least-privilege assignment while allowing broad role scopes.
 */
export function hasScope(principal: Principal | null, scope: Scope): boolean {
  if (!principal) return false;
  // Fast path: exact match
  if (principal.scopes.includes(scope)) return true;
  // Wildcard matching: convert scope patterns to family prefix checks.
  // A family wildcard 'X.*' grants every scope in family X under EITHER
  // separator — dot ('admin.read') or colon ('enterprise:read').
  for (const granted of principal.scopes) {
    if (granted.endsWith('.*')) {
      const family = granted.slice(0, -2); // e.g. 'admin' | 'enterprise'
      if (scope.startsWith(`${family}.`) || scope.startsWith(`${family}:`)) return true;
    }
  }
  return false;
}

/** Constant-time string comparison (safe for secrets). */
export function timingSafeStrEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return timingSafeEqual(bufA, bufB);
}

/* ------------------------------------------------------------------ *
 * Principal administration: create / list / revoke API keys. The raw
 * key is returned EXACTLY ONCE at creation (only its hash is persisted);
 * revocation invalidates the auth cache immediately.
 * ------------------------------------------------------------------ */

export interface PrincipalSummary {
  id: string;
  name: string;
  scopes: Scope[];
  status: string;
  createdAt: Date;
  lastUsedAt: Date | null;
}

export async function createPrincipal(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Db type is polymorphic Postgres/SQLite; narrowed at callsite
  db: any,
  name: string,
  scopes: Scope[]
): Promise<{ id: string; rawKey: string }> {
  const rawKey = generateApiKey();
  const id = `prn_${randomBytes(8).toString('hex')}`;
  await db
    .insert(apiKeys)
    .values({
      id,
      name,
      keyHash: hashApiKey(rawKey),
      // SQLite column is text: better-sqlite3 expands array bindings into extra
      // parameters, which fails with "Too many parameter values were provided".
      scopes: isSqlite ? JSON.stringify(scopes) : scopes,
      status: 'active',
    });
  invalidateAuthCache();
  return { id, rawKey };
}

export async function listPrincipals(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Db type is polymorphic Postgres/SQLite; narrowed at callsite
  db: any,
  opts?: { limit?: number; offset?: number }
): Promise<{ items: PrincipalSummary[]; total: number }> {
  const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 200);
  const offset = Math.max(opts?.offset ?? 0, 0);

  const [rows, countResult] = await Promise.all([
    db.select().from(apiKeys).orderBy(desc(apiKeys.createdAt)).limit(limit).offset(offset),
    db.select({ count: sql<number>`count(*)` }).from(apiKeys),
  ]);
  const total = Number(countResult[0]?.count ?? 0);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Db type is polymorphic Postgres/SQLite; narrowed at callsite
  const items = rows.map((r: any) => ({
    id: r.id,
    name: r.name,
    scopes: parseScopes(r.scopes),
    status: r.status,
    createdAt: r.createdAt,
    lastUsedAt: r.lastUsedAt,
  }));
  return { items, total };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Db type is polymorphic Postgres/SQLite; narrowed at callsite
export async function revokePrincipal(db: any, id: string): Promise<boolean> {
  const [updated] = await db
    .update(apiKeys)
    .set({ status: 'disabled' })
    .where(eq(apiKeys.id, id))
    .returning({ id: apiKeys.id });
  if (updated) invalidateAuthCache();
  return Boolean(updated);
}
