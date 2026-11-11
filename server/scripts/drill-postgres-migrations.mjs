#!/usr/bin/env node
/**
 * Disposable live-PostgreSQL forward/rollback/restore drill for R1 migrations 0049-0054.
 * Uses isolated schemas and never changes public tables. Default mode requires DATABASE_URL;
 * set MIGRATION_DRILL_ENGINE=pglite for a local disposable PostgreSQL-semantics preflight.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const migrations = resolve(root, 'server/src/db/migrations');
const engineMode = process.env.MIGRATION_DRILL_ENGINE === 'pglite' ? 'pglite' : 'postgres';
const evidenceName = engineMode === 'pglite'
  ? '2026-11-10-r1-pglite-isolated-schema-migration-drill.log'
  : '2026-11-10-r1-postgres-migration-drill.log';
const evidencePath = resolve(root, 'docs/bmad/releases/evidence', evidenceName);
const chain = [
  '0049_r1_contracts',
  '0050_r1_durable_task_metadata',
  '0051_r1_capability_governance',
  '0052_r1_extended',
  '0053_r1_sync',
  '0054_r1_effect_claims',
];
const lines = [];
const log = (message) => {
  console.log(message);
  lines.push(message);
};
const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const fingerprint = (schema, rows) => createHash('sha256')
  .update(JSON.stringify({ schema, rows }))
  .digest('hex');
const quoteIdentifier = (identifier) => `"${identifier.replaceAll('"', '""')}"`;

async function main() {
  const databaseUrl = (process.env.DATABASE_URL || '').trim();
  if (engineMode === 'postgres' && !/^postgres(?:ql)?:\/\//u.test(databaseUrl)) {
    throw new Error('DATABASE_URL must point to an isolated, disposable PostgreSQL service.');
  }
  const suffix = randomUUID().replaceAll('-', '');
  const drillSchema = `r1_migration_drill_${suffix}`;
  const backupSchema = `r1_migration_backup_${suffix}`;
  const drillIdent = quoteIdentifier(drillSchema);
  const backupIdent = quoteIdentifier(backupSchema);
  const started = new Date().toISOString();
  let client;
  let pool;
  let schemaCreated = false;
  let backupCreated = false;
  let passed = false;

  log(`R1 ${engineMode} 0049-0054 forward / rollback / restore drill`);
  log(`timestamp_utc=${started}`);
  log(`node=${process.version}`);
  log(`isolated_schema=${drillSchema}`);
  try {
    if (engineMode === 'postgres') {
      const postgres = (await import(process.env.POSTGRES_MODULE || 'postgres')).default;
      pool = postgres(databaseUrl, { max: 1, prepare: false, connect_timeout: 10 });
      client = await pool.reserve();
    } else {
      const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
      pool = new PGlite();
      await pool.waitReady;
      client = {
        unsafe: async (statement, parameters = []) => {
          if (parameters.length || /^\s*(SELECT|WITH)\b/iu.test(statement)) {
            return (await pool.query(statement, parameters)).rows;
          }
          return pool.exec(statement);
        },
      };
    }
    const version = await client.unsafe('SELECT version()');
    log(`engine=${engineMode}`);
    log(`server=${version[0].version}`);

    await client.unsafe(`CREATE SCHEMA ${drillIdent}`);
    schemaCreated = true;
    await client.unsafe(`CREATE SCHEMA ${backupIdent}`);
    backupCreated = true;
    await client.unsafe(`SET search_path TO ${drillIdent}`);

    // Faithful pre-R1 `projects` table from server/src/db/schema.ts.
    await client.unsafe(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT 'manual',
        status TEXT NOT NULL DEFAULT 'active'
          CHECK (status IN ('active', 'archived', 'paused')),
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

    const schemaSnapshot = async (schemaName) => {
      const [columns, constraints, indexes, routines, triggers] = await Promise.all([
        client.unsafe(`
          SELECT table_name, column_name, data_type, is_nullable, column_default
          FROM information_schema.columns WHERE table_schema = $1
          ORDER BY table_name, ordinal_position
        `, [schemaName]),
        client.unsafe(`
          SELECT c.relname AS table_name, k.conname, k.contype, pg_get_constraintdef(k.oid) AS definition
          FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 ORDER BY c.relname, k.conname
        `, [schemaName]),
        client.unsafe(`
          SELECT tablename, indexname, indexdef FROM pg_indexes
          WHERE schemaname = $1 ORDER BY tablename, indexname
        `, [schemaName]),
        client.unsafe(`
          SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS arguments,
                 pg_get_functiondef(p.oid) AS definition
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = $1 ORDER BY p.proname, arguments
        `, [schemaName]),
        client.unsafe(`
          SELECT c.relname AS table_name, t.tgname, pg_get_triggerdef(t.oid) AS definition
          FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND NOT t.tgisinternal ORDER BY c.relname, t.tgname
        `, [schemaName]),
      ]);
      return {
        columns: columns.map((row) => ({ ...row })),
        constraints: constraints.map((row) => ({ ...row })),
        indexes: indexes.map((row) => ({
          ...row,
          indexname: '<index>',
          indexdef: row.indexdef
            .replace(/^CREATE (UNIQUE )?INDEX \S+/u, (_match, unique = '') => `CREATE ${unique}INDEX <index>`)
            .replaceAll(schemaName, '<schema>'),
        })),
        routines: routines.map((row) => ({
          ...row,
          definition: row.definition.replaceAll(schemaName, '<schema>'),
        })),
        triggers: triggers.map((row) => ({
          ...row,
          definition: row.definition.replaceAll(schemaName, '<schema>'),
        })),
      };
    };
    const baseline = await schemaSnapshot(drillSchema);
    const baselineProjects = await client.unsafe('SELECT * FROM projects ORDER BY id');
    check(baseline.columns.length > 0, 'empty PostgreSQL baseline schema');

    // A schema-local physical copy is the backup: the disposable test fixture
    // contains only the pre-R1 projects table and its seed row.
    await client.unsafe(`CREATE TABLE ${backupIdent}.projects (LIKE ${drillIdent}.projects INCLUDING ALL)`);
    await client.unsafe(`INSERT INTO ${backupIdent}.projects SELECT * FROM ${drillIdent}.projects`);
    const backupRows = await client.unsafe(`SELECT * FROM ${backupIdent}.projects ORDER BY id`);
    check(JSON.stringify(backupRows) === JSON.stringify(baselineProjects), 'baseline backup rows mismatch');
    const backupSnapshot = await schemaSnapshot(backupSchema);
    if (JSON.stringify(backupSnapshot) !== JSON.stringify(baseline)) {
      log(`BASELINE SCHEMA SNAPSHOT=${JSON.stringify(baseline)}`);
      log(`BACKUP SCHEMA SNAPSHOT=${JSON.stringify(backupSnapshot)}`);
    }
    check(JSON.stringify(backupSnapshot) === JSON.stringify(baseline), 'baseline backup schema mismatch');
    const backupFingerprint = fingerprint(baseline, baselineProjects);
    log(`BACKUP OK sha256=${backupFingerprint} schema_columns=${baseline.columns.length} project_rows=${backupRows.length}`);

    for (const name of chain) {
      await client.unsafe(await readFile(resolve(migrations, `${name}.sql`), 'utf8'));
      log(`FORWARD OK ${name} exit=0`);
    }

    const now = '2026-11-10T00:00:00Z';
    await client.unsafe(`
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
    const invalidForeignKeys = await client.unsafe(`
      SELECT conname FROM pg_constraint k JOIN pg_namespace n ON n.oid = k.connamespace
      WHERE n.nspname = $1 AND k.contype = 'f' AND NOT k.convalidated
    `, [drillSchema]);
    check(invalidForeignKeys.length === 0, `unvalidated foreign keys: ${JSON.stringify(invalidForeignKeys)}`);
    const createdEvents = await client.unsafe(
      "SELECT id FROM r1_task_events WHERE task_id = 'drill-task' AND event = 'created'",
    );
    check(createdEvents.length === 1, '0050 task-created trigger did not persist its event');
    for (const mutation of [
      "UPDATE r1_evidence SET source = 'tampered' WHERE id = 'drill-evidence'",
      "DELETE FROM r1_evidence WHERE id = 'drill-evidence'",
      "UPDATE r1_action_receipts SET actor = 'tampered' WHERE id = 'drill-receipt'",
      "DELETE FROM r1_action_receipts WHERE id = 'drill-receipt'",
    ]) {
      let blocked = false;
      try {
        await client.unsafe(mutation);
      } catch (error) {
        if (!String(error?.message || error).includes('append-only')) throw error;
        blocked = true;
      }
      check(blocked, `append-only trigger allowed mutation: ${mutation}`);
    }
    log('FIXTURES OK task,task-event,approval,memory,evidence,receipt,checkpoint,compensation,effect-claim');
    log('CONTRACTS OK task-created trigger, append-only evidence/receipt guards, foreign keys');
    log('PRE-ROLLBACK foreign_key_constraints=validated');

    for (const name of [...chain].reverse()) {
      await client.unsafe(await readFile(resolve(migrations, 'down', `${name}.down.sql`), 'utf8'));
      log(`ROLLBACK OK ${name} exit=0`);
    }
    const rolledBack = await schemaSnapshot(drillSchema);
    check(JSON.stringify(rolledBack) === JSON.stringify(baseline), 'rollback schema differs from pre-R1 baseline');
    log(`ROLLBACK BASELINE SCHEMA MATCH columns=${rolledBack.columns.length}`);

    // Restore the exact baseline fixture from the schema-local backup.
    await client.unsafe(`DROP SCHEMA ${drillIdent} CASCADE`);
    schemaCreated = false;
    await client.unsafe(`CREATE SCHEMA ${drillIdent}`);
    schemaCreated = true;
    await client.unsafe(`CREATE TABLE ${drillIdent}.projects (LIKE ${backupIdent}.projects INCLUDING ALL)`);
    await client.unsafe(`INSERT INTO ${drillIdent}.projects SELECT * FROM ${backupIdent}.projects`);
    const restoredSnapshot = await schemaSnapshot(drillSchema);
    const restoredProjects = await client.unsafe(`SELECT * FROM ${drillIdent}.projects ORDER BY id`);
    check(JSON.stringify(restoredSnapshot) === JSON.stringify(baseline), 'restored schema differs from backup');
    check(JSON.stringify(restoredProjects) === JSON.stringify(baselineProjects), 'restored project rows differ from backup');
    const restoredFingerprint = fingerprint(restoredSnapshot, restoredProjects);
    check(restoredFingerprint === backupFingerprint, 'restored logical backup fingerprint differs');
    log(`RESTORE OK sha256=${restoredFingerprint} schema_columns=${restoredSnapshot.columns.length} project_rows=${restoredProjects.length}`);
    passed = true;
    log(`RESULT=PASS (${engineMode} leg; isolated schemas only)`);
  } catch (error) {
    log('RESULT=FAIL');
    const trace = error?.stack || String(error);
    lines.push(...trace.split('\n'));
    console.error(trace);
    process.exitCode = 1;
  } finally {
    if (client) {
      try {
        if (schemaCreated) await client.unsafe(`DROP SCHEMA IF EXISTS ${drillIdent} CASCADE`);
        if (backupCreated) await client.unsafe(`DROP SCHEMA IF EXISTS ${backupIdent} CASCADE`);
      } catch (error) {
        log(`CLEANUP WARNING: ${error?.message || error}`);
        if (passed) process.exitCode = 1;
      }
      client.release?.();
    }
    if (engineMode === 'pglite') await pool?.close();
    else await pool?.end({ timeout: 5 });
    await mkdir(dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, `${lines.join('\n')}\n`);
    console.log(`EVIDENCE=${evidencePath}`);
  }
}

await main();
