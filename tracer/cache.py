from __future__ import annotations

import json
import re
import sqlite3
from pathlib import Path
from typing import Any

from .config import DB_PATH, ensure_dirs
from .parsers import ProcedureInfo


def connect(db_path: Path = DB_PATH) -> sqlite3.Connection:
    ensure_dirs()
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn


def init_db(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS trace_events (
            id TEXT PRIMARY KEY,
            report_date TEXT,
            entry_datetime TEXT,
            name TEXT,
            type TEXT,
            step TEXT,
            sr_no INTEGER,
            sub_seq_no INTEGER,
            execution_query TEXT,
            details TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_trace_time ON trace_events(entry_datetime DESC);
        CREATE INDEX IF NOT EXISTS idx_trace_name_type ON trace_events(name, type);
        CREATE INDEX IF NOT EXISTS idx_trace_sequence ON trace_events(name, type, sr_no, sub_seq_no);

        CREATE TABLE IF NOT EXISTS procedure_metadata (
            name TEXT PRIMARY KEY,
            found INTEGER NOT NULL,
            log_ref_count INTEGER NOT NULL,
            calls_json TEXT NOT NULL,
            reads_json TEXT NOT NULL,
            inserts_json TEXT NOT NULL,
            updates_json TEXT NOT NULL,
            steps_json TEXT NOT NULL,
            excerpt TEXT NOT NULL,
            parsed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS sync_state (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS anomalies (
            id TEXT PRIMARY KEY,
            severity TEXT NOT NULL,
            kind TEXT NOT NULL,
            name TEXT,
            message TEXT NOT NULL,
            evidence_json TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS expected_paths (
            procedure_name TEXT,
            ordinal INTEGER,
            sr_no INTEGER,
            sub_seq_no INTEGER,
            step_text TEXT,
            kind TEXT,
            confidence REAL,
            tables_json TEXT,
            calls_json TEXT,
            error_context_json TEXT,
            source_excerpt TEXT,
            PRIMARY KEY (procedure_name, ordinal)
        );

        CREATE TABLE IF NOT EXISTS actual_runs (
            run_id TEXT PRIMARY KEY,
            name TEXT,
            type TEXT,
            execution_query_hash TEXT,
            parameter_signature TEXT,
            start_time TEXT,
            end_time TEXT,
            duration_ms INTEGER,
            status TEXT,
            event_count INTEGER,
            error_count INTEGER
        );

        CREATE TABLE IF NOT EXISTS actual_run_events (
            run_id TEXT,
            event_id TEXT,
            PRIMARY KEY (run_id, event_id)
        );

        CREATE TABLE IF NOT EXISTS run_deltas (
            run_id TEXT PRIMARY KEY,
            missing_count INTEGER,
            unexpected_count INTEGER,
            score REAL,
            delta_json TEXT
        );
        """
    )
    conn.commit()


def upsert_trace_events(conn: sqlite3.Connection, rows: list[dict[str, Any]]) -> int:
    if not rows:
        return 0
    payload = [
        (
            row.get("id"),
            row.get("report_date"),
            normalize_datetime(row.get("entry_datetime")),
            row.get("name"),
            row.get("type"),
            row.get("step"),
            row.get("sr_no"),
            row.get("sub_seq_no"),
            row.get("execution_query"),
            row.get("details"),
        )
        for row in rows
        if row.get("id")
    ]
    conn.executemany(
        """
        INSERT OR REPLACE INTO trace_events
        (id, report_date, entry_datetime, name, type, step, sr_no, sub_seq_no, execution_query, details)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        payload,
    )
    if payload:
        conn.execute(
            """
            UPDATE trace_events
            SET entry_datetime = substr(entry_datetime, 1, 10) || ' ' || substr(entry_datetime, 11)
            WHERE entry_datetime GLOB '????-??-????:*'
            """
        )
        latest_row = conn.execute("SELECT MAX(entry_datetime) AS latest FROM trace_events").fetchone()
        latest = latest_row["latest"]
        conn.execute("INSERT OR REPLACE INTO sync_state(key, value) VALUES ('watermark', ?)", (latest,))
    conn.commit()
    return len(payload)


def normalize_datetime(value: Any) -> Any:
    if not isinstance(value, str):
        return value
    fixed = value.replace("T", " ")
    fixed = re.sub(r"^(\d{4}-\d{2}-\d{2})(\d{2}:)", r"\1 \2", fixed)
    return fixed


def get_watermark(conn: sqlite3.Connection) -> str | None:
    row = conn.execute("SELECT value FROM sync_state WHERE key = 'watermark'").fetchone()
    return row["value"] if row else None


def upsert_procedures(conn: sqlite3.Connection, infos: list[ProcedureInfo]) -> None:
    conn.executemany(
        """
        INSERT OR REPLACE INTO procedure_metadata
        (name, found, log_ref_count, calls_json, reads_json, inserts_json, updates_json, steps_json, excerpt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        [
            (
                info.name,
                1 if info.found else 0,
                info.log_ref_count,
                json.dumps(info.calls),
                json.dumps(info.reads),
                json.dumps(info.inserts),
                json.dumps(info.updates),
                json.dumps(info.steps),
                info.excerpt,
            )
            for info in infos
        ],
    )
    
    if infos:
        placeholders = ",".join("?" * len(infos))
        conn.execute(f"DELETE FROM expected_paths WHERE procedure_name IN ({placeholders})", [info.name for info in infos])
        
        path_rows = []
        for info in infos:
            for step in getattr(info, "expected_path", []):
                step_key = f"{step.get('sr_no')}_{step.get('sub_seq_no')}"
                table_touches = getattr(info, "table_touches_by_step", {}).get(step_key, [])
                calls_by_step = getattr(info, "calls_by_step", {}).get(step_key, [])
                path_rows.append((
                    info.name,
                    step.get("ordinal"),
                    step.get("sr_no"),
                    step.get("sub_seq_no"),
                    step.get("step"),
                    step.get("kind"),
                    getattr(info, "confidence", 0.0),
                    json.dumps(table_touches),
                    json.dumps(calls_by_step),
                    "{}",
                    step.get("source_excerpt", "")
                ))
        if path_rows:
            conn.executemany(
                """
                INSERT INTO expected_paths 
                (procedure_name, ordinal, sr_no, sub_seq_no, step_text, kind, confidence, tables_json, calls_json, error_context_json, source_excerpt)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                path_rows
            )
            
    conn.commit()


def list_procedures(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    rows = conn.execute("SELECT * FROM procedure_metadata ORDER BY name").fetchall()
    return [_proc_row(row) for row in rows]


def get_procedure(conn: sqlite3.Connection, name: str) -> dict[str, Any] | None:
    row = conn.execute("SELECT * FROM procedure_metadata WHERE name = ?", (name,)).fetchone()
    return _proc_row(row) if row else None


def _proc_row(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "name": row["name"],
        "found": bool(row["found"]),
        "log_ref_count": row["log_ref_count"],
        "calls": json.loads(row["calls_json"]),
        "reads": json.loads(row["reads_json"]),
        "inserts": json.loads(row["inserts_json"]),
        "updates": json.loads(row["updates_json"]),
        "steps": json.loads(row["steps_json"]),
        "excerpt": row["excerpt"],
    }


def cached_summary(conn: sqlite3.Connection) -> dict[str, Any]:
    total = conn.execute("SELECT COUNT(*) AS c FROM trace_events").fetchone()["c"]
    names = conn.execute(
        """
        SELECT COALESCE(name, '<anonymous>') AS name, COUNT(*) AS trace_count,
               MIN(entry_datetime) AS first_seen, MAX(entry_datetime) AS last_seen
        FROM trace_events
        GROUP BY name
        ORDER BY trace_count DESC
        """
    ).fetchall()
    types = conn.execute(
        """
        SELECT COALESCE(type, '<null>') AS type, COUNT(*) AS trace_count
        FROM trace_events
        GROUP BY type
        ORDER BY trace_count DESC
        """
    ).fetchall()
    return {
        "cache_rows": total,
        "top_names": [dict(row) for row in names],
        "type_counts": [dict(row) for row in types],
        "watermark": get_watermark(conn),
    }


def cached_events(conn: sqlite3.Connection, params: dict[str, Any]) -> list[dict[str, Any]]:
    limit = max(1, min(int(params.get("limit") or 200), 1000))
    offset = max(0, int(params.get("offset") or 0))
    clauses = []
    values: list[Any] = []
    if params.get("name"):
        if params["name"] == "<anonymous>":
            clauses.append("name IS NULL")
        else:
            clauses.append("name = ?")
            values.append(params["name"])
    if params.get("type"):
        if params["type"] == "<null>":
            clauses.append("type IS NULL")
        else:
            clauses.append("type = ?")
            values.append(params["type"])
    if params.get("start"):
        clauses.append("entry_datetime >= ?")
        values.append(params["start"])
    if params.get("end"):
        clauses.append("entry_datetime <= ?")
        values.append(params["end"])
    if params.get("sr_no"):
        clauses.append("sr_no = ?")
        values.append(int(params["sr_no"]))
    if params.get("sub_seq_no"):
        clauses.append("sub_seq_no = ?")
        values.append(int(params["sub_seq_no"]))
    if params.get("step"):
        clauses.append("step LIKE ?")
        values.append(f"%{params['step']}%")
    if params.get("q"):
        clauses.append("(step LIKE ? OR execution_query LIKE ? OR details LIKE ?)")
        needle = f"%{params['q']}%"
        values.extend([needle, needle, needle])
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    rows = conn.execute(
        f"""
        SELECT * FROM trace_events
        {where}
        ORDER BY entry_datetime DESC, id DESC
        LIMIT ? OFFSET ?
        """,
        [*values, limit, offset],
    ).fetchall()
    return [dict(row) for row in rows]


def step_catalog(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT COALESCE(name, '<anonymous>') AS name,
               COALESCE(type, '<null>') AS type,
               sr_no,
               sub_seq_no,
               step,
               COUNT(*) AS trace_count,
               MIN(entry_datetime) AS first_seen,
               MAX(entry_datetime) AS last_seen
        FROM trace_events
        GROUP BY name, type, sr_no, sub_seq_no, step
        ORDER BY name, type, sr_no, sub_seq_no
        """
    ).fetchall()
    return [dict(row) for row in rows]
