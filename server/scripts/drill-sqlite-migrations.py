#!/usr/bin/env python3
"""Disposable SQLite forward/rollback/restore drill for R1 migrations 0049-0054.

Uses Python's stdlib SQLite driver to avoid modifying any application database.
All generated databases live in a temporary directory and are deleted on exit.
"""
from __future__ import annotations

import argparse
import hashlib
import shutil
import sqlite3
import sys
import tempfile
import traceback
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BASELINE = ROOT / "server/drizzle/0000_baseline_schema.sql"
MIGRATIONS = ROOT / "server/src/db/migrations"
EVIDENCE = ROOT / "docs/bmad/releases/evidence/2026-11-10-r1-sqlite-migration-drill.log"
CHAIN = [
    "0049_r1_contracts",
    "0050_r1_durable_task_metadata",
    "0051_r1_capability_governance",
    "0052_r1_extended",
    "0053_r1_sync",
    "0054_r1_effect_claims",
]


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def schema(conn: sqlite3.Connection) -> list[tuple[str, str, str, str]]:
    return conn.execute(
        "SELECT type, name, tbl_name, sql FROM sqlite_schema "
        "WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"
    ).fetchall()


def check(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, default=EVIDENCE)
    args = parser.parse_args()
    args.evidence.parent.mkdir(parents=True, exist_ok=True)
    lines: list[str] = []

    def log(message: str) -> None:
        print(message, flush=True)
        lines.append(message)

    log("R1 SQLite 0049-0054 forward / rollback / restore drill")
    log(f"timestamp_utc={datetime.now(timezone.utc).isoformat()}")
    log(f"repository={ROOT}")
    log(f"python={sys.version.split()[0]}")
    log(f"sqlite={sqlite3.sqlite_version}")
    try:
        check(tuple(map(int, sqlite3.sqlite_version.split("."))) >= (3, 35, 0),
              "SQLite >= 3.35.0 is required for DROP COLUMN")
        check(BASELINE.is_file(), f"baseline not found: {BASELINE}")
        with tempfile.TemporaryDirectory(prefix="agentic-os-r1-sqlite-drill-") as temp:
            directory = Path(temp)
            database = directory / "r1-drill.sqlite"
            backup = directory / "pre-r1-backup.sqlite"
            conn = sqlite3.connect(database)
            conn.execute("PRAGMA foreign_keys = ON")
            conn.executescript(BASELINE.read_text(encoding="utf-8"))
            conn.commit()
            baseline_schema = schema(conn)
            check(conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok",
                  "fresh baseline integrity check failed")
            conn.close()
            shutil.copy2(database, backup)
            log(f"BACKUP OK sha256={sha256(backup)} bytes={backup.stat().st_size}")
            log(f"BASELINE SCHEMA objects={len(baseline_schema)}")

            conn = sqlite3.connect(database)
            conn.execute("PRAGMA foreign_keys = ON")
            for migration in CHAIN:
                path = MIGRATIONS / f"{migration}.sqlite.sql"
                check(path.is_file(), f"missing forward SQL: {path}")
                conn.executescript(path.read_text(encoding="utf-8"))
                conn.commit()
                log(f"FORWARD OK {migration} exit=0")

            # Insert representative rows spanning the parent/child and new-ledger paths.
            now = "2026-11-10T00:00:00Z"
            project, task = "drill-project", "drill-task"
            conn.execute(
                "INSERT INTO projects(id,name,created_at,updated_at) VALUES(?,?,?,?)",
                (project, "R1 migration drill", now, now),
            )
            conn.execute(
                "INSERT INTO r1_tasks(id,project_id,title,correlation_id,idempotency_key,created_at,updated_at) "
                "VALUES(?,?,?,?,?,?,?)",
                (task, project, "fixture", "corr-drill", "idem-drill", now, now),
            )
            conn.execute(
                "INSERT INTO r1_approvals(id,project_id,task_id,capability_id,state,created_at,updated_at) "
                "VALUES(?,?,?,?,?,?,?)",
                ("drill-approval", project, task, "cap-drill", "approved", now, now),
            )
            conn.execute(
                "INSERT INTO r1_memories(id,project_id,content,created_at,updated_at) VALUES(?,?,?,?,?)",
                ("drill-memory", project, "fixture", now, now),
            )
            conn.execute(
                "INSERT INTO r1_evidence(id,project_id,task_id,kind,source,content_hash,created_at) "
                "VALUES(?,?,?,?,?,?,?)",
                ("drill-evidence", project, task, "source", "drill", "a" * 64, now),
            )
            conn.execute(
                "INSERT INTO r1_action_receipts(id,project_id,correlation_id,kind,actor,decision,created_at) "
                "VALUES(?,?,?,?,?,?,?)",
                ("drill-receipt", project, "corr-drill", "tool_call", "drill", "allow", now),
            )
            conn.execute(
                "INSERT INTO r1_checkpoints(id,project_id,task_id,sequence,state_snapshot,created_at) "
                "VALUES(?,?,?,?,?,?)",
                ("drill-checkpoint", project, task, 0, "{}", now),
            )
            conn.execute(
                "INSERT INTO r1_compensations(id,project_id,task_id,target_step_id,reason,state,created_at) "
                "VALUES(?,?,?,?,?,?,?)",
                ("drill-compensation", project, task, "step-drill", "fixture", "completed", now),
            )
            conn.execute(
                "INSERT INTO r1_effect_claims(project_id,task_id,correlation_id,operation,state,created_at,completed_at) "
                "VALUES(?,?,?,?,?,?,?)",
                (project, task, "corr-drill", "tool_call", "completed", now, now),
            )
            conn.commit()
            fk_errors = conn.execute("PRAGMA foreign_key_check").fetchall()
            check(not fk_errors, f"fixture foreign key violations: {fk_errors}")
            log("FIXTURES OK task,task-event,approval,memory,evidence,receipt,checkpoint,compensation,effect-claim")
            log("PRE-ROLLBACK foreign_key_check=ok integrity_check=" + conn.execute("PRAGMA integrity_check").fetchone()[0])

            for migration in reversed(CHAIN):
                path = MIGRATIONS / "down" / f"{migration}.down.sqlite.sql"
                check(path.is_file(), f"missing rollback SQL: {path}")
                conn.executescript(path.read_text(encoding="utf-8"))
                conn.commit()
                log(f"ROLLBACK OK {migration} exit=0")

            rolled_schema = schema(conn)
            check(rolled_schema == baseline_schema,
                  "post-rollback schema differs from pristine pre-R1 baseline")
            project_columns = {row[1] for row in conn.execute("PRAGMA table_info(projects)")}
            check({"mode", "scope", "idempotency_key"}.issubset(project_columns),
                  "baseline project metadata columns were removed by rollback")
            check(conn.execute("PRAGMA foreign_key_check").fetchall() == [],
                  "post-rollback foreign key check failed")
            check(conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok",
                  "post-rollback integrity check failed")
            conn.close()
            log(f"ROLLBACK BASELINE SCHEMA MATCH objects={len(rolled_schema)}")
            log("ROLLBACK CHECKS foreign_key_check=ok integrity_check=ok baseline_project_columns=preserved")

            # Restore the verified pre-R1 backup and repeat schema/integrity checks.
            database.unlink()
            shutil.copy2(backup, database)
            conn = sqlite3.connect(database)
            conn.execute("PRAGMA foreign_keys = ON")
            check(schema(conn) == baseline_schema, "restored schema differs from backup baseline")
            check(conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok",
                  "restored database integrity check failed")
            check(conn.execute("PRAGMA foreign_key_check").fetchall() == [],
                  "restored database foreign key check failed")
            conn.close()
            check(sha256(database) == sha256(backup), "restored database bytes differ from backup")
            log(f"RESTORE OK sha256={sha256(database)} bytes={database.stat().st_size}")
            log("RESULT=PASS (SQLite leg only; PGlite and PostgreSQL remain unverified)")
    except Exception:
        log("RESULT=FAIL")
        lines.extend(traceback.format_exc().rstrip().splitlines())
        args.evidence.write_text("\n".join(lines) + "\n", encoding="utf-8")
        print("\n".join(lines[-8:]), file=sys.stderr)
        return 1

    args.evidence.write_text("\n".join(lines) + "\n", encoding="utf-8")
    log(f"EVIDENCE={args.evidence}")
    # Rewrite to ensure the evidence path line itself is retained.
    args.evidence.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
