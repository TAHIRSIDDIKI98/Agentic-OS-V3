#!/usr/bin/env node
/** Disposable PGlite forward/rollback/restore drill for R1 migrations 0049-0054. */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const migrations = resolve(root, 'server/src/db/migrations');
const evidencePath = resolve(root, 'docs/bmad/releases/evidence/2026-11-10-r1-pglite-migration-drill.log');
const chain = [
  '0049_r1_contracts',
  '0050_r1_durable_task_metadata',
  '0051_r1_capability_governance',
  '0052_r1_extended',
  '0053_r1_sync',
  '0054_r1_effect_claims',
];
const PGlite = (await import(process.env.PGLITE_MODULE || '@electric-sql/pglite')).PGlite;
const lines = [];
const log = (message) => {
  console.log(message);
  lines.push(message);
};
const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function schema(db) {
  const columns = await db.query(`
    SELECT table_name, column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public'
    ORDER BY table_name, ordinal_position
  `);
  const indexes = await db.query(`
    SELECT tablename, indexname, indexdef FROM pg_indexes
    WHERE schemaname = 'public' ORDER BY tablename, indexname
  `);
  const routines = await db.query(`
    SELECT routine_name, routine_type, data_type
    FROM information_schema.routines
    WHERE specific_schema = 'public' ORDER BY routine_name, routine_type
  `);
  const triggers = await db.query(`
    SELECT event_object_table, trigger_name, action_timing, event_manipulation
    FROM information_schema.triggers
    WHERE trigger_schema = 'public'
    ORDER BY event_object_table, trigger_name, event_manipulation
  `);
  return { columns: columns.rows, indexes: indexes.rows, routines: routines.rows, triggers: triggers.rows };
}

async function main() {
  const started = new Date().toISOString();
  log('R1 PGlite 0049-0054 forward / rollback / restore drill');
  log(`timestamp_utc=${started}`);
  log(`node=${process.version}`);
  log(`pglite=${(await import(process.env.PGLITE_MODULE || '@electric-sql/pglite')).version || '0.5.4 (package lock)'}`);
  const work = await mkdtemp(resolve(tmpdir(), 'agentic-os-r1-pglite-drill-'));
  let db;
  let restored;
  try {
    db = new PGlite();
    await db.waitReady;
    // Model the pre-0049 PostgreSQL projects table from server/src/db/schema.ts.
    await db.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT 'manual',
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived','paused')),
        memory_count INTEGER NOT NULL DEFAULT 0,
        skill_count INTEGER NOT NULL DEFAULT 0,
        token_footprint INTEGER NOT NULL DEFAULT 0,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX project_name_unique ON projects(name);
      INSERT INTO projects (id, name) VALUES ('pre-r1-project', 'Pre-R1 baseline');
    `);
    const baseline = await schema(db);
    check(baseline.columns.length > 0, 'empty baseline schema');
    const backup = await db.dumpDataDir();
    const backupBytes = new Uint8Array(await backup.arrayBuffer());
    const backupPath = resolve(work, 'pre-r1-backup.tar');
    await writeFile(backupPath, backupBytes);
    log(`BACKUP OK sha256=${digest(backupBytes)} bytes=${backupBytes.byteLength}`);
    log(`BASELINE SCHEMA columns=${baseline.columns.length} indexes=${baseline.indexes.length}`);

    for (const name of chain) {
      await db.exec(await readFile(resolve(migrations, `${name}.sql`), 'utf8'));
      log(`FORWARD OK ${name} exit=0`);
    }

    const now = '2026-11-10T00:00:00Z';
    await db.exec(`
      INSERT INTO projects (id, name) VALUES ('drill-project', 'R1 migration drill');
      INSERT INTO r1_tasks (id, project_id, title, correlation_id, idempotency_key, created_at, updated_at)
        VALUES ('drill-task', 'drill-project', 'fixture', 'corr-drill', 'idem-drill', '${now}', '${now}');
      INSERT INTO r1_approvals (id, project_id, task_id, capability_id, state, created_at, updated_at)
        VALUES ('drill-approval', 'drill-project', 'drill-task', 'cap-drill', 'approved', '${now}', '${now}');
      INSERT INTO r1_memories (id, project_id, content, created_at, updated_at)
        VALUES ('drill-memory', 'drill-project', 'fixture', '${now}', '${now}');
      INSERT INTO r1_evidence (id, project_id, task_id, kind, source, content_hash, created_at)
        VALUES ('drill-evidence', 'drill-project', 'drill-task', 'source', 'drill', '${'a'.repeat(64)}', '${now}');
      INSERT INTO r1_action_receipts (id, project_id, correlation_id, kind, actor, decision, created_at)
        VALUES ('drill-receipt', 'drill-project', 'corr-drill', 'tool_call', 'drill', 'allow', '${now}');
      INSERT INTO r1_checkpoints (id, project_id, task_id, sequence, state_snapshot, created_at)
        VALUES ('drill-checkpoint', 'drill-project', 'drill-task', 0, '{}'::jsonb, '${now}');
      INSERT INTO r1_compensations (id, project_id, task_id, target_step_id, reason, state, created_at)
        VALUES ('drill-compensation', 'drill-project', 'drill-task', 'step-drill', 'fixture', 'completed', '${now}');
      INSERT INTO r1_effect_claims (project_id, task_id, correlation_id, operation, state, created_at, completed_at)
        VALUES ('drill-project', 'drill-task', 'corr-drill', 'tool_call', 'completed', '${now}', '${now}');
    `);
    const fk = await db.query('SELECT * FROM pg_catalog.pg_constraint c WHERE c.contype = $1 AND NOT c.convalidated', ['f']);
    check(fk.rows.length === 0, 'unvalidated foreign-key constraints found');
    log('FIXTURES OK task,task-event,approval,memory,evidence,receipt,checkpoint,compensation,effect-claim');
    log('PRE-ROLLBACK foreign_key_constraints=validated');

    for (const name of [...chain].reverse()) {
      await db.exec(await readFile(resolve(migrations, 'down', `${name}.down.sql`), 'utf8'));
      log(`ROLLBACK OK ${name} exit=0`);
    }
    const afterRollback = await schema(db);
    check(JSON.stringify(afterRollback) === JSON.stringify(baseline), 'rollback schema differs from pre-R1 baseline');
    const r1Objects = await db.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name LIKE 'r1_%'
    `);
    check(r1Objects.rows.length === 0, `R1 tables remain after rollback: ${JSON.stringify(r1Objects.rows)}`);
    log(`ROLLBACK BASELINE SCHEMA MATCH columns=${afterRollback.columns.length} indexes=${afterRollback.indexes.length}`);

    await db.close();
    db = undefined;
    restored = new PGlite({ loadDataDir: backup });
    await restored.waitReady;
    const restoredSchema = await schema(restored);
    check(JSON.stringify(restoredSchema) === JSON.stringify(baseline), 'restored schema differs from backup');
    const restoredProject = await restored.query("SELECT id, name FROM projects WHERE id = 'pre-r1-project'");
    check(restoredProject.rows.length === 1, 'restored baseline project missing');
    const restoredDump = await restored.dumpDataDir();
    const restoredBytes = new Uint8Array(await restoredDump.arrayBuffer());
    log(`RESTORE OK sha256=${digest(restoredBytes)} schema=baseline project=present`);
    log('RESULT=PASS (PGlite leg only; SQLite and live PostgreSQL are separate checks)');
  } catch (error) {
    log('RESULT=FAIL');
    const trace = error?.stack || String(error);
    lines.push(...trace.split('\n'));
    console.error(trace);
    process.exitCode = 1;
  } finally {
    await db?.close().catch(() => {});
    await restored?.close().catch(() => {});
    await rm(work, { recursive: true, force: true });
    await mkdir(dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, `${lines.join('\n')}\n`);
    console.log(`EVIDENCE=${evidencePath}`);
  }
}

await main();
