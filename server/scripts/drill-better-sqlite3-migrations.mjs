#!/usr/bin/env node
/** Disposable native better-sqlite3 forward/rollback/restore drill for R1 0049-0054. */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const betterSqliteModule = process.env.BETTER_SQLITE3_MODULE || 'better-sqlite3';
const betterSqliteEntry = require.resolve(betterSqliteModule);
const Database = require(betterSqliteEntry);
const betterSqliteVersion = JSON.parse(
  await readFile(resolve(dirname(betterSqliteEntry), '../package.json'), 'utf8')
).version;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const migrations = resolve(root, 'server/src/db/migrations');
const baselinePath = resolve(root, 'server/drizzle/0000_baseline_schema.sql');
const evidencePath = resolve(root, 'docs/bmad/releases/evidence/2026-11-10-r1-better-sqlite3-migration-drill.log');
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
const hashFile = async (file) => createHash('sha256').update(await readFile(file)).digest('hex');

function schema(db) {
  return db.prepare(`
    SELECT type, name, tbl_name, sql FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name
  `).all();
}

async function main() {
  const work = await mkdtemp(resolve(tmpdir(), 'agentic-os-r1-better-sqlite3-drill-'));
  const dbPath = resolve(work, 'r1-drill.sqlite');
  const backupPath = resolve(work, 'pre-r1-backup.sqlite');
  let db;
  try {
    log('R1 better-sqlite3 0049-0054 forward / rollback / restore drill');
    log(`timestamp_utc=${new Date().toISOString()}`);
    log(`node=${process.version}`);
    log(`better-sqlite3=${betterSqliteVersion}`);
    db = new Database(dbPath);
    db.pragma('foreign_keys = ON');
    db.exec(await readFile(baselinePath, 'utf8'));
    const baseline = schema(db);
    const sqliteVersion = db.prepare('SELECT sqlite_version() AS version').get().version;
    check(db.pragma('integrity_check', { simple: true }) === 'ok', 'fresh baseline integrity failed');
    db.close();
    db = undefined;
    await copyFile(dbPath, backupPath);
    log(`sqlite=${sqliteVersion}`);
    log(`BACKUP OK sha256=${await hashFile(backupPath)} bytes=${(await readFile(backupPath)).byteLength}`);
    log(`BASELINE SCHEMA objects=${baseline.length}`);

    db = new Database(dbPath);
    db.pragma('foreign_keys = ON');
    for (const name of chain) {
      db.exec(await readFile(resolve(migrations, `${name}.sqlite.sql`), 'utf8'));
      log(`FORWARD OK ${name} exit=0`);
    }

    const now = '2026-11-10T00:00:00Z';
    const fixture = db.transaction(() => {
      db.prepare('INSERT INTO projects(id,name,created_at,updated_at) VALUES(?,?,?,?)')
        .run('drill-project', 'R1 migration drill', now, now);
      db.prepare(`INSERT INTO r1_tasks(id,project_id,title,correlation_id,idempotency_key,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?)`).run('drill-task', 'drill-project', 'fixture', 'corr-drill', 'idem-drill', now, now);
      db.prepare(`INSERT INTO r1_approvals(id,project_id,task_id,capability_id,state,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?)`).run('drill-approval', 'drill-project', 'drill-task', 'cap-drill', 'approved', now, now);
      db.prepare('INSERT INTO r1_memories(id,project_id,content,created_at,updated_at) VALUES(?,?,?,?,?)')
        .run('drill-memory', 'drill-project', 'fixture', now, now);
      db.prepare(`INSERT INTO r1_evidence(id,project_id,task_id,kind,source,content_hash,created_at)
        VALUES(?,?,?,?,?,?,?)`).run('drill-evidence', 'drill-project', 'drill-task', 'source', 'drill', 'a'.repeat(64), now);
      db.prepare(`INSERT INTO r1_action_receipts(id,project_id,correlation_id,kind,actor,decision,created_at)
        VALUES(?,?,?,?,?,?,?)`).run('drill-receipt', 'drill-project', 'corr-drill', 'tool_call', 'drill', 'allow', now);
      db.prepare(`INSERT INTO r1_checkpoints(id,project_id,task_id,sequence,state_snapshot,created_at)
        VALUES(?,?,?,?,?,?)`).run('drill-checkpoint', 'drill-project', 'drill-task', 0, '{}', now);
      db.prepare(`INSERT INTO r1_compensations(id,project_id,task_id,target_step_id,reason,state,created_at)
        VALUES(?,?,?,?,?,?,?)`).run('drill-compensation', 'drill-project', 'drill-task', 'step-drill', 'fixture', 'completed', now);
      db.prepare(`INSERT INTO r1_effect_claims(project_id,task_id,correlation_id,operation,state,created_at,completed_at)
        VALUES(?,?,?,?,?,?,?)`).run('drill-project', 'drill-task', 'corr-drill', 'tool_call', 'completed', now, now);
    });
    fixture();
    const fkErrors = db.pragma('foreign_key_check');
    check(fkErrors.length === 0, `fixture foreign-key errors: ${JSON.stringify(fkErrors)}`);
    check(db.pragma('integrity_check', { simple: true }) === 'ok', 'pre-rollback integrity failed');
    log('FIXTURES OK task,task-event,approval,memory,evidence,receipt,checkpoint,compensation,effect-claim');
    log('PRE-ROLLBACK foreign_key_check=ok integrity_check=ok');

    for (const name of [...chain].reverse()) {
      db.exec(await readFile(resolve(migrations, 'down', `${name}.down.sqlite.sql`), 'utf8'));
      log(`ROLLBACK OK ${name} exit=0`);
    }
    check(JSON.stringify(schema(db)) === JSON.stringify(baseline), 'rollback schema differs from baseline');
    const projectColumns = new Set(db.pragma('table_info(projects)').map((column) => column.name));
    check(['mode', 'scope', 'idempotency_key'].every((column) => projectColumns.has(column)),
      'baseline project metadata columns were removed');
    check(db.pragma('foreign_key_check').length === 0, 'post-rollback foreign-key check failed');
    check(db.pragma('integrity_check', { simple: true }) === 'ok', 'post-rollback integrity failed');
    log(`ROLLBACK BASELINE SCHEMA MATCH objects=${baseline.length}`);
    log('ROLLBACK CHECKS foreign_key_check=ok integrity_check=ok baseline_project_columns=preserved');
    db.close();
    db = undefined;

    await rm(dbPath, { force: true });
    await copyFile(backupPath, dbPath);
    db = new Database(dbPath);
    db.pragma('foreign_keys = ON');
    check(JSON.stringify(schema(db)) === JSON.stringify(baseline), 'restored schema differs from backup');
    check(db.pragma('integrity_check', { simple: true }) === 'ok', 'restored integrity failed');
    check(db.pragma('foreign_key_check').length === 0, 'restored foreign-key check failed');
    db.close();
    db = undefined;
    check(await hashFile(dbPath) === await hashFile(backupPath), 'restored bytes differ from backup');
    log(`RESTORE OK sha256=${await hashFile(dbPath)} bytes=${(await readFile(dbPath)).byteLength}`);
    log('RESULT=PASS (native better-sqlite3 leg only; PGlite and live PostgreSQL are separate checks)');
  } catch (error) {
    log('RESULT=FAIL');
    const trace = error?.stack || String(error);
    lines.push(...trace.split('\n'));
    console.error(trace);
    process.exitCode = 1;
  } finally {
    db?.close();
    await rm(work, { recursive: true, force: true });
    await mkdir(dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, `${lines.join('\n')}\n`);
    console.log(`EVIDENCE=${evidencePath}`);
  }
}

await main();
