#!/usr/bin/env node
/**
 * R1 migration matrix — forward and rollback, with retained evidence.
 *
 * Scope: migrations 0049–0054 in both dialects. The R1 migrations reference only
 * `projects` as a base table, which is the same prerequisite the repository's own
 * R1 contract tests create (server/tests/r1-effect-claims-contract.test.ts).
 *
 * Engines:
 *   - sqlite  : file database via better-sqlite3 (always runs)
 *   - postgres: live server via psql when NEXUS_PG_URL is set
 *   - pglite  : covered by server/tests/r1-effect-claims-contract.test.ts (forward only)
 *
 * Usage:
 *   NEXUS_PG_URL=postgresql://USER:PASSWORD@127.0.0.1:5432/nexus_r1_matrix \
 *     node scripts/run-r1-migration-matrix.mjs
 *
 * Exit 0 only when every executed engine migrates forward, rolls back, and
 * leaves the base schema intact.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = join(ROOT, 'server', 'src', 'db', 'migrations');
const requireFromServer = createRequire(join(ROOT, 'server', 'package.json'));

const FORWARD = ['0049_r1_contracts', '0050_r1_durable_task_metadata', '0051_r1_capability_governance', '0052_r1_extended', '0053_r1_sync', '0054_r1_effect_claims'];

const PROJECTS_PG = `
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
`;

const checks = [];
function record(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function read(name, dialect) {
  return readFileSync(join(MIGRATIONS, dialect === 'sqlite' ? `${name}.sqlite.sql` : `${name}.sql`), 'utf8');
}

function readDown(name, dialect) {
  const file = dialect === 'sqlite' ? `${name}.down.sqlite.sql` : `${name}.down.sql`;
  return readFileSync(join(MIGRATIONS, 'down', file), 'utf8');
}

function sqliteTables(db) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => row.name);
}

function runSqlite() {
  const Database = requireFromServer('better-sqlite3');
  const dir = mkdtempSync(join(tmpdir(), 'nexus-r1-matrix-'));
  const file = join(dir, 'matrix.db');
  const db = new Database(file);
  try {
    // SQLite 0049 creates `projects` itself; only PostgreSQL needs the base stub.
    for (const name of FORWARD) {
      db.exec(read(name, 'sqlite'));
    }
    const migrated = sqliteTables(db);
    const r1 = migrated.filter((table) => table.startsWith('r1_'));
    record('sqlite:forward', r1.length > 0, `${r1.length} r1_* tables`);

    for (const name of [...FORWARD].reverse()) {
      db.exec(readDown(name, 'sqlite'));
    }
    const rolledBack = sqliteTables(db);
    const remainingR1 = rolledBack.filter((table) => table.startsWith('r1_'));
    record('sqlite:rollback-removes-r1', remainingR1.length === 0, remainingR1.join(',') || 'none left');
    record('sqlite:base-preserved', rolledBack.includes('projects'), rolledBack.join(','));
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function runPglite() {
  const entry = requireFromServer.resolve('@electric-sql/pglite');
  const mod = await import(pathToFileURL(entry).href);
  const PGlite = mod.PGlite ?? mod.default?.PGlite;
  if (!PGlite) throw new Error('PGlite export not found');
  const db = new PGlite();
  try {
    await db.exec(PROJECTS_PG);
    for (const name of FORWARD) await db.exec(read(name, 'postgres'));
    const tablesOf = async () =>
      (await db.query("select tablename from pg_tables where schemaname='public' order by tablename")).rows.map(
        (row) => row.tablename
      );
    const migrated = await tablesOf();
    const r1 = migrated.filter((table) => table.startsWith('r1_'));
    record('pglite:forward', r1.length > 0, `${r1.length} r1_* tables`);

    for (const name of [...FORWARD].reverse()) await db.exec(readDown(name, 'postgres'));
    const after = await tablesOf();
    const remainingR1 = after.filter((table) => table.startsWith('r1_'));
    record('pglite:rollback-removes-r1', remainingR1.length === 0, remainingR1.join(',') || 'none left');
    record('pglite:base-preserved', after.includes('projects'), after.join(','));

    for (const name of FORWARD) await db.exec(read(name, 'postgres'));
    const reapplied = (await tablesOf()).filter((table) => table.startsWith('r1_'));
    record('pglite:reapply-after-rollback', reapplied.length === r1.length, `${reapplied.length} r1_* tables`);
  } finally {
    await db.close();
  }
}

function psql(url, args, options = {}) {
  const result = spawnSync('psql', [url, '-v', 'ON_ERROR_STOP=1', '-q', ...args], {
    encoding: 'utf8',
    env: { ...process.env },
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`psql failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function runPostgres(url) {
  const dbName = 'nexus_r1_matrix';
  // Recreate through the maintenance database, never the target itself.
  const admin = new URL(url);
  admin.pathname = '/postgres';
  const adminUrl = admin.toString();
  psql(adminUrl, ['-c', `DROP DATABASE IF EXISTS ${dbName};`]);
  psql(adminUrl, ['-c', `CREATE DATABASE ${dbName};`]);

  const target = new URL(url);
  target.pathname = `/${dbName}`;
  const targetUrl = target.toString();

  psql(targetUrl, ['-c', PROJECTS_PG]);
  const before = psql(targetUrl, ['-tAc', "select tablename from pg_tables where schemaname='public' order by tablename"]).trim().split('\n').filter(Boolean);

  for (const name of FORWARD) {
    psql(targetUrl, ['-f', join(MIGRATIONS, `${name}.sql`)]);
  }
  const migrated = psql(targetUrl, ['-tAc', "select tablename from pg_tables where schemaname='public' order by tablename"]).trim().split('\n').filter(Boolean);
  const r1 = migrated.filter((table) => table.startsWith('r1_'));
  record('postgres:forward', r1.length > 0, `${r1.length} r1_* tables`);

  // Sentinel rows + physical backup before rollback, restored after it.
  psql(targetUrl, ['-c', "INSERT INTO projects (id, name) VALUES ('r1-matrix-sentinel', 'sentinel');"]);
  psql(targetUrl, [
    '-c',
    "INSERT INTO r1_tasks (id, project_id, state, title, correlation_id, idempotency_key, created_at, updated_at) VALUES ('r1-matrix-sentinel-task', 'r1-matrix-sentinel', 'queued', 'sentinel', 'sentinel-corr', 'sentinel-idem', NOW(), NOW());",
  ]);
  const dumpDir = mkdtempSync(join(tmpdir(), 'nexus-r1-restore-'));
  const dump = join(dumpDir, 'matrix.dump');
  const dumped = spawnSync('pg_dump', [targetUrl, '-Fc', '-f', dump], { encoding: 'utf8' });
  if (dumped.status !== 0) throw new Error(`pg_dump failed: ${dumped.stderr || dumped.stdout}`);

  for (const name of [...FORWARD].reverse()) {
    psql(targetUrl, ['-f', join(MIGRATIONS, 'down', `${name}.down.sql`)]);
  }
  const rolledBack = psql(targetUrl, ['-tAc', "select tablename from pg_tables where schemaname='public' order by tablename"]).trim().split('\n').filter(Boolean);
  const remainingR1 = rolledBack.filter((table) => table.startsWith('r1_'));
  record('postgres:rollback-removes-r1', remainingR1.length === 0, remainingR1.join(',') || 'none left');
  record('postgres:base-preserved', rolledBack.includes('projects'), rolledBack.join(','));
  record('postgres:before-after', before.join(',') === rolledBack.join(','), `${before.length} → ${rolledBack.length} tables`);

  // Restore-from-empty check: forward apply again on the rolled-back database.
  for (const name of FORWARD) psql(targetUrl, ['-f', join(MIGRATIONS, `${name}.sql`)]);
  const reforwarded = psql(targetUrl, ['-tAc', "select count(*) from pg_tables where schemaname='public' and tablename like 'r1_%'"]).trim();
  record('postgres:reapply-after-rollback', Number(reforwarded) === r1.length, `${reforwarded} r1_* tables`);

  // Restore the pre-rollback backup into a fresh database and verify the sentinels.
  const restoreName = 'nexus_r1_restore';
  psql(adminUrl, ['-c', `DROP DATABASE IF EXISTS ${restoreName};`]);
  psql(adminUrl, ['-c', `CREATE DATABASE ${restoreName};`]);
  const restoreUrl = new URL(targetUrl);
  restoreUrl.pathname = `/${restoreName}`;
  const restored = spawnSync(
    'pg_restore',
    ['--no-owner', '--no-privileges', '--dbname', restoreUrl.toString(), dump],
    { encoding: 'utf8' }
  );
  if (restored.status !== 0) throw new Error(`pg_restore failed: ${restored.stderr || restored.stdout}`);
  const sentinelTask = psql(restoreUrl.toString(), [
    '-tAc',
    "select count(*) from r1_tasks where id='r1-matrix-sentinel-task'",
  ]).trim();
  const sentinelProject = psql(restoreUrl.toString(), [
    '-tAc',
    "select count(*) from projects where id='r1-matrix-sentinel'",
  ]).trim();
  record(
    'postgres:restore-from-backup',
    sentinelTask === '1' && sentinelProject === '1',
    `task=${sentinelTask} project=${sentinelProject}`
  );
  psql(adminUrl, ['-c', `DROP DATABASE ${restoreName};`]);
  rmSync(dumpDir, { recursive: true, force: true });
}

async function main() {
  mkdirSync(join(ROOT, '.local', 'baseline'), { recursive: true });
  runSqlite();
  await runPglite();
  const pgUrl = process.env.NEXUS_PG_URL;
  if (pgUrl) {
    runPostgres(pgUrl);
  } else {
    record('postgres:matrix', false, 'NEXUS_PG_URL not set — live PostgreSQL leg not executed');
  }

  const failures = checks.filter((check) => !check.ok);
  const artifact = join(ROOT, '.local', 'baseline', 'r1-migration-matrix.json');
  writeFileSync(artifact, `${JSON.stringify({ generatedAt: new Date().toISOString(), platform: process.platform, checks }, null, 2)}\n`, 'utf8');
  console.log(`\n${checks.length - failures.length}/${checks.length} checks passed`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
