/**
 * client.ts — Unified SQLite (default) / PostgreSQL client with auto-detection.
 *
 * Connection is eagerly created at module load time (fail-fast).
 * ESM-compatible: uses createRequire for better-sqlite3 (CJS native),
 * but uses import() for drizzle-orm (ESM) so the relational query API works.
 *
 * Additionally re-exports the correct schema tables for the active backend
 * so application code can `import { db, apiKeys } from "./db/client.js";`
 * without worrying about which schema file is active.
 *
 * PHASE 4 ENHANCEMENTS:
 * - async-mutex for write serialization (replaces hand-rolled queue)
 * - Transaction execution timeout (30s auto-rollback)
 * - Exponential backoff retry for SQLITE_BUSY errors
 * - dbHealthy() connection health check
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Mutex } from 'async-mutex';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import type { Sql } from 'postgres';
import { sql } from 'drizzle-orm';
import * as sqliteSchema from './schema-sqlite.js';
import * as pgSchema from './schema.js';
import { getEnv } from '../lib/env.js';
import { dbQueryDuration } from '../services/metrics.js';
import { startToolSpan, endTracedSpan, recordSpanError } from '../services/tracing.js';

const rawUrl = (getEnv().DATABASE_URL || '').trim();
export const isSqlite = !(rawUrl.startsWith('postgres://') || rawUrl.startsWith('postgresql://'));

let _sqlite: SqliteDatabase | null = null;
let _pgClient: Sql | null = null;

/** Maximum time (ms) a single transaction may hold the mutex before forced rollback. */
const TX_TIMEOUT_MS = 30_000;

/** Maximum number of retry attempts for SQLITE_BUSY errors. */
const MAX_RETRIES = 5;

/** Base delay (ms) for exponential backoff. */
const RETRY_BASE_DELAY_MS = 100;

// ── SQLite Write Mutex ──────────────────────────────────────
// Replaces the hand-rolled queue with a proper async-mutex.
// Serializes SQLite write operations to prevent transaction interleaving.
// SQLite only supports one writer at a time; with an async callback in
// withTransaction, the event loop could schedule a second BEGIN before
// the first COMMIT, causing "cannot start a transaction within a transaction".
const _writeMutex = new Mutex();

function isSqliteBusyError(err: unknown): boolean {
  if (err && typeof err === 'object') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- unified runtime adapter intentionally erases incompatible Drizzle generic types at single boundary
    const msg = String((err as any).message || '');
    return msg.includes('SQLITE_BUSY') || msg.includes('database is locked');
  }
  return false;
}

/**
 * Sleep for `ms` milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sqliteTableExists(conn: SqliteDatabase, table: string): boolean {
  const row = conn
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
  return Boolean(row);
}

function findSqliteBaselinePath(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(process.cwd(), 'drizzle/0000_baseline_schema.sql'),
    resolve(process.cwd(), 'server/drizzle/0000_baseline_schema.sql'),
    resolve(here, '../../drizzle/0000_baseline_schema.sql'),
    resolve(here, '../../../server/drizzle/0000_baseline_schema.sql'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function shouldIgnoreSqliteSchemaError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /already exists|duplicate column name|duplicate index name/i.test(msg);
}

function ensureSqliteBaseline(conn: SqliteDatabase): void {
  const requiredTables = ['agents', 'agent_tasks', 'memories', 'skills', 'audit_log', 'memory_rehearsal_log'];
  if (requiredTables.every((table) => sqliteTableExists(conn, table))) return;

  const baselinePath = findSqliteBaselinePath();
  if (!baselinePath) return;

  const sqlText = readFileSync(baselinePath, 'utf8');
  const statements = sqlText
    .split(/-->\s*statement-breakpoint/g)
    .map((statement) => statement.trim())
    .filter(Boolean);

  for (const statement of statements) {
    try {
      conn.exec(statement);
    } catch (e) {
      if (!shouldIgnoreSqliteSchemaError(e)) throw e;
    }
  }
}

function createSqliteDb() {
  const Database = require('better-sqlite3');
  const conn = new Database(getEnv().NEXUS_SQLITE_PATH);
  const originalPrepare = conn.prepare.bind(conn);
  conn.prepare = ((source: string) =>
    originalPrepare(source.replace(/::(?:int|integer|float|real|text|jsonb)\b/g, ''))) as typeof conn.prepare;
  conn.pragma('journal_mode = WAL');
  conn.pragma('foreign_keys = ON');
  conn.pragma('busy_timeout = 5000');
  conn.pragma('synchronous = NORMAL');
  ensureSqliteBaseline(conn);
  // Enable FTS5 if available — insert-only triggers.
  // DELETE/UPDATE triggers are omitted: the FTS5 'delete' row-marker
  // operation is not universally supported across SQLite builds and
  // causes \"SQL logic error\" on some environments. FTS content tables
  // can be rebuilt periodically via REINDEX when needed.
  try {
    conn.pragma('compile_options');
    conn.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(id UNINDEXED, title, content, tags);
      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(id, title, content, tags) VALUES (new.id, new.title, new.content, new.tags);
      END;

      CREATE VIRTUAL TABLE IF NOT EXISTS skills_fts USING fts5(id UNINDEXED, name, title, description, content, tags, category);
      CREATE TRIGGER IF NOT EXISTS skills_ai AFTER INSERT ON skills BEGIN
        INSERT INTO skills_fts(id, name, title, description, content, tags, category) VALUES (new.id, new.name, new.title, new.description, new.content, new.tags, new.category);
      END;

      CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(id UNINDEXED, title, content, path);
      CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
        INSERT INTO notes_fts(id, title, content, path) VALUES (new.id, new.title, new.content, new.path);
      END;
    `);
  } catch {
    // FTS5 may not be compiled in; ignore.
  }
  _sqlite = conn;

  // Use require for drizzle-orm/better-sqlite3 — drizzle-orm v0.45 ships CJS
  const { drizzle } = require('drizzle-orm/better-sqlite3') as {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- unified runtime adapter intentionally erases incompatible Drizzle generic types at single boundary
    drizzle: (client: any, opts?: { schema?: Record<string, any> }) => any;
  };
  return drizzle(conn, { schema: sqliteSchema });
}

function createPgDb() {
  const postgres = require('postgres');
  const { drizzle } = require('drizzle-orm/postgres-js') as {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- unified runtime adapter intentionally erases incompatible Drizzle generic types at single boundary
    drizzle: (client: any, opts?: { schema?: Record<string, any> }) => any;
  };
  const client = postgres(rawUrl, {
    max: 20,
    idle_timeout: 30,
    connect_timeout: 10,
  });
  _pgClient = client;
  return drizzle(client, { schema: pgSchema });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- unified runtime adapter intentionally erases incompatible Drizzle generic types at single boundary
export type DatabaseType = any;
// DbTx is defined below, so we remove the duplicate at line 122

const db: DatabaseType = isSqlite ? createSqliteDb() : createPgDb();
if (isSqlite) {
  db.transaction = async <T>(fn: (tx: DbTx) => Promise<T>): Promise<T> => withTransaction(fn);
}

/** Human-readable backend label. */
export const getBackend = (): string => (isSqlite ? 'sqlite' : 'postgresql');

/** Clean shutdown — safe to call multiple times. */
export async function closeDb(): Promise<void> {
  if (_sqlite) {
    try {
      _sqlite.close();
    } catch {
      // Already closed.
    }
  }
  if (_pgClient) {
    try {
      await _pgClient.end();
    } catch {
      // Already closed.
    }
  }
}

/** True if the pool is currently connected. */
export function isPoolInitialized(): boolean {
  return Boolean(_sqlite || _pgClient);
}

/**
 * Check if the database is reachable.
 * For SQLite: performs a `SELECT 1`.
 * For PostgreSQL: performs `SELECT 1`.
 * Returns `true` if the database responds, `false` otherwise.
 */
export async function dbHealthy(): Promise<boolean> {
  try {
    if (isSqlite && _sqlite) {
      _sqlite.exec('SELECT 1');
      return true;
    }
    if (_pgClient) {
      await _pgClient`SELECT 1`;
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export { db };

export function getPgClient(): Sql | null {
  return _pgClient;
}

/**
 * Minimal parameterized SQL boundary for the R1 repository adapter.
 *
 * R1 uses PostgreSQL-style `$1` placeholders. SQLite's native driver expects
 * `?` placeholders, so translation occurs only here, where the active driver
 * is known. Values are always passed separately and are never interpolated
 * into the statement.
 */
export interface ApplicationSqlExecutor {
  query<T extends object>(statement: string, parameters?: readonly unknown[]): Promise<readonly T[]>;
}

function sqliteStatement(statement: string, parameters: readonly unknown[]): { statement: string; parameters: unknown[] } {
  const sqliteParameters: unknown[] = [];
  const translated = statement.replace(/\$(\d+)/g, (_placeholder, position: string) => {
    const index = Number(position) - 1;
    if (!Number.isSafeInteger(index) || index < 0 || index >= parameters.length) {
      throw new Error(`SQL placeholder $${position} has no matching parameter.`);
    }
    sqliteParameters.push(parameters[index]);
    return '?';
  });
  return { statement: translated, parameters: sqliteParameters };
}

export function createApplicationSqlExecutor(): ApplicationSqlExecutor {
  if (isSqlite) {
    const connection = _sqlite;
    if (!connection) throw new Error('SQLite client was not initialized.');
    return {
      async query<T extends object>(statement: string, parameters: readonly unknown[] = []): Promise<readonly T[]> {
        const translated = sqliteStatement(statement, parameters);
        const prepared = connection.prepare(translated.statement);
        // SELECT and DML statements with RETURNING are readers. Plain DML must
        // use run(), which also lets SQLite append-only triggers surface their
        // own rejection instead of a misleading "does not return data" error.
        if (prepared.reader) {
          return prepared.all(...translated.parameters) as T[];
        }
        prepared.run(...translated.parameters as never[]);
        return [];
      },
    };
  }

  const connection = _pgClient;
  if (!connection) throw new Error('PostgreSQL client was not initialized.');
  return {
    async query<T extends object>(statement: string, parameters: readonly unknown[] = []): Promise<readonly T[]> {
      return (await connection.unsafe(statement, [...parameters] as never[])) as T[];
    },
  };
}

/** Execute an application-owned migration against the active native client. */
export async function executeApplicationSql(statement: string): Promise<void> {
  if (isSqlite) {
    if (!_sqlite) throw new Error('SQLite client was not initialized.');
    _sqlite.exec(statement);
    return;
  }
  if (!_pgClient) throw new Error('PostgreSQL client was not initialized.');
  await _pgClient.unsafe(statement);
}

export async function getDbLockStatus() {
  if (isSqlite) {
    return {
      isLocked: _writeMutex.isLocked(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- unified runtime adapter intentionally erases incompatible Drizzle generic types at single boundary
      queueLength: (_writeMutex as any)._queue?.length || 0,
    };
  } else {
    try {
      const rows = await db.execute(sql`
        SELECT count(*) as count FROM pg_locks
      `);
      return {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- unified runtime adapter intentionally erases incompatible Drizzle generic types at single boundary
        isLocked: (rows as any)[0]?.count > 0,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- unified runtime adapter intentionally erases incompatible Drizzle generic types at single boundary
        count: Number((rows as any)[0]?.count || 0),
      };
    } catch {
      return { isLocked: false, count: 0 };
    }
  }
}

/**
 * Cross-backend async transaction helper.
 *
 * PostgreSQL: uses `db.transaction()`, which natively accepts async callbacks.
 * SQLite: uses a mutex to serialize write access + manual BEGIN/COMMIT/ROLLBACK.
 *
 * SAFETY FEATURES:
 * - 30-second transaction timeout: if the callback does not resolve within
 *   TX_TIMEOUT_MS, the transaction is automatically rolled back.
 * - Exponential backoff retry: if a SQLITE_BUSY error is caught, the
 *   transaction is retried up to MAX_RETRIES times with increasing delay.
 *
 * IMPORTANT: Do NOT perform network calls (LLM requests, embedding generation)
 * inside the transaction callback — hold the mutex for the minimum time possible.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- unified runtime adapter intentionally erases incompatible Drizzle generic types at single boundary
export type DbTx = any;

/**
 * Cross-backend async transaction helper.
 *
 * PostgreSQL: uses `db.transaction()`, which natively accepts async callbacks.
 * SQLite: uses a mutex to serialize write access + manual BEGIN/COMMIT/ROLLBACK.
 *
 * SAFETY FEATURES:
 * - 30-second transaction timeout: if the callback does not resolve within
 *   TX_TIMEOUT_MS, the transaction is automatically rolled back.
 * - Exponential backoff retry: if a SQLITE_BUSY error is caught, the
 *   transaction is retried up to MAX_RETRIES times with increasing delay.
 *
 * IMPORTANT: Do NOT perform network calls (LLM requests, embedding generation)
 * inside the transaction callback — hold the mutex for the minimum time possible.
 */
export async function withTransaction<T>(fn: (tx: DbTx) => Promise<T>): Promise<T> {
  const startTime = performance.now();
  const span = startToolSpan('db.transaction', { agentId: 'system', toolName: 'db.transaction' });
  try {
    const res = isSqlite ? await withTransactionSqlite(fn) : await withTransactionPg(fn);
    const durationSeconds = (performance.now() - startTime) / 1000;
    dbQueryDuration.observe({ query: 'transaction' }, durationSeconds);
    await endTracedSpan(span);
    return res;
  } catch (err) {
    const durationSeconds = (performance.now() - startTime) / 1000;
    dbQueryDuration.observe({ query: 'transaction' }, durationSeconds);
    recordSpanError(span, err instanceof Error ? err.message : String(err));
    await endTracedSpan(span);
    throw err;
  }
}

async function withTransactionSqlite<T>(fn: (tx: DbTx) => Promise<T>): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      // Exponential backoff: 100ms, 200ms, 400ms, 800ms, ...
      const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
      await sleep(delay);
    }

    const release = await _writeMutex.acquire();
    try {
      _sqlite!.exec('BEGIN');
      try {
        const result = await withTimeout(
          fn(db),
          TX_TIMEOUT_MS,
          'Transaction timed out after 30s — rolling back.'
        );
        _sqlite!.exec('COMMIT');
        return result;
      } catch (e) {
        _sqlite!.exec('ROLLBACK');
        if (isSqliteBusyError(e) && attempt < MAX_RETRIES - 1) {
          lastError = e;
          continue; // Retry
        }
        throw e;
      }
    } finally {
      release();
    }
  }

  throw lastError ?? new Error('withTransaction: exhausted retries');
}

async function withTransactionPg<T>(fn: (tx: DbTx) => Promise<T>): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- unified runtime adapter intentionally erases incompatible Drizzle generic types at single boundary
  const pgDb = db as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- unified runtime adapter intentionally erases incompatible Drizzle generic types at single boundary
  return await pgDb.transaction(async (tx: any) => {
    return await withTimeout(
      fn(tx),
      TX_TIMEOUT_MS,
      'Postgres transaction timed out after 30s — rolling back.'
    );
  });
}

/**
 * Wraps a promise with a timeout.
 * If the promise does not settle within `ms`, the timeout error is thrown.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number, timeoutMessage: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(timeoutMessage));
    }, ms);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* ── Re-export the correct schema tables for the active backend ── */
export const {
  apiKeys,
  agents,
  agentTasks,
  auditLog,
  merkleCheckpoints,
  anchoredRoots,
  memories,
  skills,
  notes,
  projects,
  feedback,
  systemMeta,
  tokenLedger,
  trajectoryLogs,
  toolReceipts,
  cronJobs,
  stateSnapshots,
  spanLogs,
  sandboxExecutions,
  compiledScripts,
  metricSnapshots,
  improvementProposals,
  plugins,
  pluginInstallations,
  pluginKv,
  pluginReceipts,
  federatedMemoryProofs,
  llmProviderHealth,
  llmTokenBudgets,
  pipelines,
  pipelineRuns,
  ringPolicies,
  schedulerMetrics,
  memoryClusters,
  memoryClusterMembers,
  sessionLinks,
  memoryCausalEdges,
  memoryAttachments,
  memoryContradictions,
  memoryEmotions,
  tagTaxonomy,
  memoryTags,
  memoryTemplates,
  agentMemoryQuotas,
  memoryArchive,
  memoryDiffMarkers,
  memoryRehearsalLog,
  selfOptParamVersions,
  selfOptExperiments,
  selfOptKnowledgeBus,
  selfOptEvents,
  orgs,
  workspaces,
  enterpriseUsers,
  enterpriseApiKeys,
  rbacRoles,
  siemSinks,
  tenantConfig,
  invoices,
  paymentMethods,
  crossOrgShares,
  onboardingState,
} = isSqlite ? sqliteSchema : pgSchema;
