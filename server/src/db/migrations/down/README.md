# Migration Down-Scripts (rollback path)

**Purpose:** Gate-0 blocker B3 requires a forward/rollback/restore matrix for migrations
0049–0054. The runtime migrator (`drizzle-kit migrate` via `server/src/setup.ts`) is
forward-only and never reads this directory — these scripts are **operational rollback
artifacts** applied manually during the WS3 drill (blocker B3) or an emergency rollback.

## Convention

- One pair per forward step: `NNNN_name.down.sql` (PostgreSQL) and
  `NNNN_name.down.sqlite.sql` (SQLite), reversing `../NNNN_name(.sqlite).sql` exactly.
- Child objects first. PostgreSQL statements use `IF EXISTS`; SQLite `DROP COLUMN`
  statements are intentionally single-use because supported SQLite versions do not accept
  `DROP COLUMN IF EXISTS`. Apply each engine's rollback chain exactly once, in reverse order.
- **Data is not preserved**: rolling back an additive R1 slice discards R1-only rows.
  Always take a backup first (`pg_dump` / file copy of the SQLite database).

## Drill procedure (per engine: PostgreSQL 15+/pgvector, SQLite, and PGlite)

1. Use a disposable database only. Backup the pre-state (dump or file copy) and record its hash.
2. Forward: apply 0049→0054 in order with the engine's native SQL client.
3. Rollback: apply `down/0054…down` → `down/0049…down` in reverse order, once.
4. Restore: re-apply the backup; verify schema, foreign keys, and integrity.
5. Retain per-step command + exit-code transcripts under `docs/bmad/releases/evidence/`.

Reproduce the SQLite SQL leg from the repository root with
`python3 server/scripts/drill-sqlite-migrations.py`. It creates and removes a temporary
baseline database and records its transcript at
`docs/bmad/releases/evidence/2026-11-10-r1-sqlite-migration-drill.log`. This validates
SQLite 3.40.1 SQL behavior; it does not substitute for the better-sqlite3 runtime.

Reproduce the native runtime leg with `node server/scripts/drill-better-sqlite3-migrations.mjs`
when server dependencies are installed. It applies the full chain using better-sqlite3 and
verifies rollback schema, integrity, foreign keys, and byte-identical backup restoration. Its
transcript is at `docs/bmad/releases/evidence/2026-11-10-r1-better-sqlite3-migration-drill.log`.

Reproduce the PGlite data-directory drill with `node server/scripts/drill-pglite-migrations.mjs`.
It runs the PostgreSQL SQL chain against a disposable, minimal pre-R1 `projects` schema and
restores a PGlite `dumpDataDir` backup. Its transcript is retained at
`docs/bmad/releases/evidence/2026-11-10-r1-pglite-migration-drill.log`.

The isolated-schema script `server/scripts/drill-postgres-migrations.mjs` also supports a local
PGlite preflight with `MIGRATION_DRILL_ENGINE=pglite`; it snapshots/restores a schema modeled on
the pre-R1 projects table and writes `2026-11-10-r1-pglite-isolated-schema-migration-drill.log`.
For live PostgreSQL, run it with `DATABASE_URL` set to a disposable service. It creates unique
temporary schemas only and never mutates `public`. CI invokes this live mode against its PostgreSQL
16 service and retains the raw transcript as the `r1-postgres-migration-drill` artifact. Until
that CI run passes, PGlite remains a preflight rather than live PostgreSQL evidence.

## Status

| Step | PostgreSQL down | SQLite down |
|---|---|---|
| 0049 r1_contracts | ✅ authored | ✅ authored |
| 0050 r1_durable_task_metadata | ✅ authored | ✅ authored |
| 0051 r1_capability_governance | ✅ authored | ✅ authored |
| 0052 r1_extended | ✅ authored | ✅ authored |
| 0053 r1_sync | ✅ authored | ✅ authored |
| 0054 r1_effect_claims | ✅ authored | ✅ authored |

Full rollback chain 0054→0049 is authored. The disposable SQLite SQL check (SQLite 3.40.1),
native better-sqlite3 runtime check (SQLite 3.49.2), and PGlite 0.5.4 check have passed their
forward/rollback/restore drills; transcripts are retained above. PGlite used a minimal baseline
schema, so live PostgreSQL against the supported production baseline remains the final B3 leg.
These drills are isolated and do not depend on WS1/WS8.
