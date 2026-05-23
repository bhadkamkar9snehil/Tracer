from __future__ import annotations

"""
Tracer analyzer module
======================

CODE INDEX
----------
1. Module constants and small type aliases
2. SQLite / JSON / timestamp helper functions
3. Expected-path helpers
   - canonical expected path loading from expected_paths, with procedure_metadata fallback
   - normalized expected-step records for playback, graphing, and run-delta storage
4. Actual-event helpers
   - filtered trace event loading
   - selected-run event loading
   - execution-parameter extraction
5. Delta helpers
   - robust expected-vs-actual matching by SrNo/SubSeqNo and step text
   - shared delta calculation used by playback and saved run deltas
6. Public analytics API
   - analyze()
   - graph_payload()
   - playback_payload()
   - expected_path_payload()
7. Runtime/run reconstruction API
   - reconstruct_and_save_runs()
   - get_runs()
   - get_run_detail()
   - analyze_run_delta()
8. Presentation helpers
   - readable_node_label()
   - meaningful_table_name()
   - _anomaly()

Design goals
------------
- Keep the public function names compatible with the existing server/app.
- Use one canonical expected-path loader everywhere, so playback, expected graph,
  and saved run deltas cannot disagree simply because they read different tables.
- Never report a fake perfect match when no expected path exists. In that case,
  return expected_unavailable=True and score=None.
- Be tolerant of production data variation: nullable step text, timestamps with or
  without milliseconds, absent optional tables, absent optional columns, and long
  selected runs.
"""

import hashlib
import json
import re
import sqlite3
import uuid
from collections import defaultdict
from datetime import datetime
from typing import Any, Iterable

Row = sqlite3.Row
Record = dict[str, Any]

ANONYMOUS_NAME = "<anonymous>"
NULL_TYPE = "<null>"
RUN_SPLIT_SECONDS = 300
MAX_FILTERED_PLAYBACK_ROWS = 1000
MAX_SELECTED_RUN_ROWS = 20000

EDGE_PRIORITY = {
    "error": 90,
    "calls": 80,
    "writes": 75,
    "updates": 60,
    "reads": 40,
    "static_step": 20,
}

EDGE_LABELS = {
    "calls": "calls",
    "reads": "reads from",
    "writes": "writes to",
    "updates": "updates",
    "static_step": "step of",
    "error": "error",
}

STRONG_EDGE_KINDS = {"calls", "writes", "updates", "error"}
TABLE_KIND_PRIORITY = ["table_write", "table_update", "table_read", "table"]


# ---------------------------------------------------------------------------
# 1. SQLite / JSON / timestamp helpers
# ---------------------------------------------------------------------------

def _dict(row: Row | None) -> Record | None:
    """Return a normal dict for a sqlite3.Row, keeping None as None."""
    return dict(row) if row is not None else None


def _dicts(rows: Iterable[Row]) -> list[Record]:
    """Convert sqlite rows into JSON-serializable dictionaries."""
    return [dict(row) for row in rows]


def _table_exists(conn: sqlite3.Connection, table_name: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?",
        (table_name,),
    ).fetchone()
    return row is not None


def _table_columns(conn: sqlite3.Connection, table_name: str) -> set[str]:
    if not _table_exists(conn, table_name):
        return set()
    return {row["name"] for row in conn.execute(f"PRAGMA table_info({table_name})")}


def _column_exists(conn: sqlite3.Connection, table_name: str, column_name: str) -> bool:
    return column_name in _table_columns(conn, table_name)


def _column_allows_null(conn: sqlite3.Connection, table_name: str, column_name: str) -> bool:
    """Return whether a SQLite table column permits NULL values."""
    if not _table_exists(conn, table_name):
        return True
    for row in conn.execute(f"PRAGMA table_info({table_name})"):
        if row["name"] == column_name:
            return not bool(row["notnull"])
    return True


def _storage_score_for_run_delta(conn: sqlite3.Connection, score: float | None) -> float | None:
    """Adapt logical delta scores to the current run_deltas.score schema."""
    if score is not None:
        return score
    return None if _column_allows_null(conn, "run_deltas", "score") else -1.0


def _actual_runs_count(conn: sqlite3.Connection) -> int:
    if not _table_exists(conn, "actual_runs"):
        return 0
    row = conn.execute("SELECT COUNT(*) AS c FROM actual_runs").fetchone()
    return _safe_int(row["c"] if row else 0)


def _safe_json_loads(value: Any, fallback: Any) -> Any:
    """Parse JSON while treating blank, NULL, and malformed values as fallback."""
    if value is None or value == "":
        return fallback
    if isinstance(value, (list, dict)):
        return value
    try:
        return json.loads(str(value))
    except (TypeError, json.JSONDecodeError):
        return fallback


def _json_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, default=str)


def _safe_int(value: Any, default: int = 0) -> int:
    try:
        if value is None or value == "":
            return default
        return int(value)
    except (TypeError, ValueError):
        return default


def _safe_limit(value: Any, default: int, upper: int) -> int:
    return max(1, min(_safe_int(value, default), upper))


def _parse_dt(value: Any) -> datetime | None:
    """
    Parse the timestamp formats this project has produced so far.

    SQL trace rows commonly use 'YYYY-MM-DD HH:MM:SS.mmm', but SQLite/cache data
    can also contain second-level precision. A tolerant parser keeps run
    reconstruction from failing on one valid timestamp variant.
    """
    if value is None:
        return None
    text = str(value).strip().replace("T", " ")
    if not text:
        return None

    # Normalize ISO suffixes that occasionally appear in API/cache payloads.
    text = text.rstrip("Z")
    if "+" in text:
        text = text.split("+", 1)[0].strip()

    candidates = [
        text[:26],
        text[:23],
        text[:19],
        text,
    ]
    formats = [
        "%Y-%m-%d %H:%M:%S.%f",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d %H:%M",
        "%Y-%m-%d",
    ]
    for candidate in candidates:
        for fmt in formats:
            try:
                return datetime.strptime(candidate, fmt)
            except ValueError:
                continue
    return None


def _dt_sort_key(value: Any) -> tuple[int, str]:
    dt = _parse_dt(value)
    if dt is None:
        return (0, str(value or ""))
    return (1, dt.isoformat(timespec="microseconds"))


def _date_diff_seconds(left: Any, right: Any) -> float:
    t1 = _parse_dt(left)
    t2 = _parse_dt(right)
    if t1 is None or t2 is None:
        return 0.0
    return (t2 - t1).total_seconds()


def _as_name(value: Any) -> str:
    return str(value or ANONYMOUS_NAME)


def _as_type(value: Any) -> str:
    return str(value or NULL_TYPE)


# ---------------------------------------------------------------------------
# 2. Expected-path helpers - one canonical source for all comparisons
# ---------------------------------------------------------------------------

def load_expected_steps(conn: sqlite3.Connection, name: str | None) -> list[Record]:
    """
    Load expected steps for one procedure from the best available source.

    Priority:
    1. expected_paths table, when present and populated. This has richer fields
       such as ordinal, kind, tables, calls, confidence, and excerpts.
    2. procedure_metadata.steps_json fallback. This is available in the older
       cache and is enough for SrNo/SubSeqNo and step-text comparison.

    Every returned step uses the same normalized field names, regardless of
    source. Downstream code should not read expected_paths/procedure_metadata
    directly; use this helper instead.
    """
    if not name:
        return []

    expected_from_table = _load_expected_steps_from_expected_paths(conn, name)
    if expected_from_table:
        return expected_from_table

    return _load_expected_steps_from_procedure_metadata(conn, name)


def _load_expected_steps_from_expected_paths(conn: sqlite3.Connection, name: str) -> list[Record]:
    if not _table_exists(conn, "expected_paths"):
        return []

    rows = conn.execute(
        "SELECT * FROM expected_paths WHERE procedure_name = ? ORDER BY ordinal",
        (name,),
    ).fetchall()
    steps: list[Record] = []
    for idx, row in enumerate(rows, start=1):
        record = dict(row)
        step = {
            "ordinal": record.get("ordinal") if record.get("ordinal") is not None else idx,
            "sr_no": record.get("sr_no"),
            "sub_seq_no": record.get("sub_seq_no"),
            "step": record.get("step_text") or record.get("step") or f"Expected step {idx}",
            "kind": record.get("kind") or "step",
            "confidence": record.get("confidence"),
            "tables": _safe_json_loads(record.get("tables_json"), []),
            "calls": _safe_json_loads(record.get("calls_json"), []),
            "error_context": _safe_json_loads(record.get("error_context_json"), {}),
            "source_excerpt": record.get("source_excerpt") or "",
            "source": "expected_paths",
        }
        steps.append(step)
    return _normalize_expected_steps(steps)


def _load_expected_steps_from_procedure_metadata(conn: sqlite3.Connection, name: str) -> list[Record]:
    if not _table_exists(conn, "procedure_metadata"):
        return []

    row = conn.execute(
        "SELECT steps_json FROM procedure_metadata WHERE name = ?",
        (name,),
    ).fetchone()
    if not row:
        return []

    raw_steps = _safe_json_loads(row["steps_json"], [])
    steps: list[Record] = []
    for idx, item in enumerate(raw_steps, start=1):
        if not isinstance(item, dict):
            continue
        steps.append(
            {
                "ordinal": item.get("ordinal") or idx,
                "sr_no": item.get("sr_no"),
                "sub_seq_no": item.get("sub_seq_no"),
                "step": item.get("step") or item.get("step_text") or f"Expected step {idx}",
                "kind": item.get("kind") or "step",
                "confidence": item.get("confidence"),
                "tables": item.get("tables") or [],
                "calls": item.get("calls") or [],
                "error_context": item.get("error_context") or {},
                "source_excerpt": item.get("source_excerpt") or "",
                "source": "procedure_metadata",
            }
        )
    return _normalize_expected_steps(steps)


def _normalize_expected_steps(steps: list[Record]) -> list[Record]:
    """Normalize numeric and textual fields without dropping unknown values."""
    normalized: list[Record] = []
    for idx, step in enumerate(steps, start=1):
        item = dict(step)
        item["ordinal"] = _safe_int(item.get("ordinal"), idx)
        item["sr_no"] = _none_or_int(item.get("sr_no"))
        item["sub_seq_no"] = _none_or_int(item.get("sub_seq_no"))
        item["step"] = str(item.get("step") or item.get("step_text") or f"Expected step {idx}")
        item["kind"] = str(item.get("kind") or "step")
        item["tables"] = item.get("tables") if isinstance(item.get("tables"), list) else []
        item["calls"] = item.get("calls") if isinstance(item.get("calls"), list) else []
        item["error_context"] = item.get("error_context") if isinstance(item.get("error_context"), dict) else {}
        normalized.append(item)
    normalized.sort(key=lambda s: (_safe_int(s.get("ordinal"), 999999), _safe_int(s.get("sr_no"), 999999), _safe_int(s.get("sub_seq_no"), 999999)))
    return normalized


def _none_or_int(value: Any) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def expected_path_unavailable(name: str | None, expected: list[Record]) -> bool:
    return bool(name) and not expected


# ---------------------------------------------------------------------------
# 3. Actual-event helpers
# ---------------------------------------------------------------------------

def _event_select_columns(conn: sqlite3.Connection, alias: str = "") -> str:
    """
    Select a stable event shape while tolerating optional Details/details column.

    When alias is supplied, ordinary columns are qualified as alias.column, but
    synthetic fallback expressions remain unqualified SQL expressions.
    """
    prefix = f"{alias}." if alias else ""
    columns = _table_columns(conn, "trace_events")
    base = [
        "id",
        "entry_datetime",
        "name",
        "type",
        "sr_no",
        "sub_seq_no",
        "step",
        "execution_query",
    ]
    select_parts = [f"{prefix}{column}" for column in base]
    if "details" in columns:
        select_parts.append(f"{prefix}details")
    else:
        select_parts.append("'' AS details")
    return ", ".join(select_parts)


def _load_actual_events_for_run(conn: sqlite3.Connection, run_id: str) -> list[Record]:
    """Load every trace event for a selected reconstructed run.

    Selected-run playback is a correctness comparison, not a UI browsing query,
    so it intentionally does not apply MAX_FILTERED_PLAYBACK_ROWS.
    """
    if not (_table_exists(conn, "actual_run_events") and _table_exists(conn, "trace_events")):
        return []
    columns = _event_select_columns(conn, "e")
    rows = conn.execute(
        f"""
        SELECT {columns}
        FROM trace_events e
        JOIN actual_run_events re ON re.event_id = e.id
        WHERE re.run_id = ?
        ORDER BY e.entry_datetime ASC, e.sr_no ASC, e.sub_seq_no ASC, e.id ASC
        """,
        (run_id,),
    ).fetchall()
    return _dicts(rows)


def _load_actual_events_for_filters(conn: sqlite3.Connection, filters: dict[str, Any]) -> list[Record]:
    clauses: list[str] = []
    values: list[Any] = []

    if filters.get("name"):
        clauses.append("name = ?")
        values.append(filters["name"])
    if filters.get("type"):
        clauses.append("type = ?")
        values.append(filters["type"])
    if filters.get("start"):
        clauses.append("entry_datetime >= ?")
        values.append(filters["start"])
    if filters.get("end"):
        clauses.append("entry_datetime <= ?")
        values.append(filters["end"])
    if filters.get("sr_no") not in (None, ""):
        clauses.append("sr_no = ?")
        values.append(filters["sr_no"])
    if filters.get("sub_seq_no") not in (None, ""):
        clauses.append("sub_seq_no = ?")
        values.append(filters["sub_seq_no"])
    if filters.get("step"):
        clauses.append("step LIKE ?")
        values.append(f"%{filters['step']}%")
    if filters.get("q"):
        q = f"%{filters['q']}%"
        if _column_exists(conn, "trace_events", "details"):
            clauses.append("(step LIKE ? OR execution_query LIKE ? OR details LIKE ?)")
            values.extend([q, q, q])
        else:
            clauses.append("(step LIKE ? OR execution_query LIKE ?)")
            values.extend([q, q])

    limit = _safe_limit(filters.get("limit"), 300, MAX_FILTERED_PLAYBACK_ROWS)
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    columns = _event_select_columns(conn)
    rows = conn.execute(
        f"""
        SELECT {columns}
        FROM trace_events
        {where}
        ORDER BY entry_datetime ASC, sr_no ASC, sub_seq_no ASC, id ASC
        LIMIT ?
        """,
        [*values, limit],
    ).fetchall()
    return _dicts(rows)


# ---------------------------------------------------------------------------
# 4. Delta helpers - shared by playback and run-delta storage
# ---------------------------------------------------------------------------

def compare_expected_to_actual(expected: list[Record], actual: list[Record]) -> Record:
    """
    Compare expected steps to actual trace events.

    Matching strategy:
    1. Match each expected step to one actual event by exact SrNo/SubSeqNo.
    2. Match SrNo-only expected steps to one actual event with the same SrNo.
    3. Match remaining expected steps by normalized step text.

    Duplicate/retry actual rows are not unexpected when an already explained
    expected key or step text accounts for them. If the same SrNo/SubSeqNo is
    present but the text is materially different, the actual row remains
    unexpected so bad instrumentation is still visible.
    """
    matched_expected: set[int] = set()
    matched_actual: set[int] = set()

    actual_exact: dict[tuple[int, int], list[int]] = defaultdict(list)
    actual_sr: dict[int, list[int]] = defaultdict(list)
    actual_text: list[tuple[int, str]] = []

    expected_exact: dict[tuple[int, int], list[int]] = defaultdict(list)
    expected_sr: dict[int, list[int]] = defaultdict(list)
    expected_text: list[tuple[int, str]] = []

    for e_idx, step in enumerate(expected):
        sr = _none_or_int(step.get("sr_no"))
        sub = _none_or_int(step.get("sub_seq_no"))
        if sr is not None:
            expected_sr[sr].append(e_idx)
            if sub is not None:
                expected_exact[(sr, sub)].append(e_idx)
        text = normal_step(step.get("step") or step.get("step_text"))
        if text:
            expected_text.append((e_idx, text))

    for a_idx, event in enumerate(actual):
        sr = _none_or_int(event.get("sr_no"))
        sub = _none_or_int(event.get("sub_seq_no"))
        if sr is not None:
            actual_sr[sr].append(a_idx)
            if sub is not None:
                actual_exact[(sr, sub)].append(a_idx)
        text = normal_step(event.get("step"))
        if text:
            actual_text.append((a_idx, text))

    def match_expected_to_actual(e_idx: int, candidates: list[int]) -> None:
        if e_idx in matched_expected:
            return
        for a_idx in candidates:
            if a_idx not in matched_actual:
                matched_expected.add(e_idx)
                matched_actual.add(a_idx)
                return

    # Pass 1: exact SrNo/SubSeqNo matching.
    for e_idx, step in enumerate(expected):
        sr = _none_or_int(step.get("sr_no"))
        sub = _none_or_int(step.get("sub_seq_no"))
        if sr is not None and sub is not None:
            match_expected_to_actual(e_idx, actual_exact.get((sr, sub), []))

    # Pass 2: SrNo-only matching only for expected steps without SubSeqNo.
    for e_idx, step in enumerate(expected):
        if e_idx in matched_expected:
            continue
        sr = _none_or_int(step.get("sr_no"))
        sub = _none_or_int(step.get("sub_seq_no"))
        if sr is not None and sub is None:
            match_expected_to_actual(e_idx, actual_sr.get(sr, []))

    # Pass 3: text fallback for unmatched expected steps.
    for e_idx, expected_step_text in expected_text:
        if e_idx in matched_expected:
            continue
        for a_idx, actual_step_text in actual_text:
            if a_idx in matched_actual:
                continue
            if _step_texts_match(expected_step_text, actual_step_text):
                matched_expected.add(e_idx)
                matched_actual.add(a_idx)
                break

    missing_expected = [step for idx, step in enumerate(expected) if idx not in matched_expected]

    def actual_is_explained_duplicate(event: Record) -> bool:
        sr = _none_or_int(event.get("sr_no"))
        sub = _none_or_int(event.get("sub_seq_no"))
        actual_step_text = normal_step(event.get("step"))

        def text_blank_or_similar(e_idx: int) -> bool:
            if not actual_step_text:
                return True
            expected_step_text = normal_step(expected[e_idx].get("step") or expected[e_idx].get("step_text"))
            return _step_texts_match(expected_step_text, actual_step_text)

        if sr is not None and sub is not None:
            keyed_expected = expected_exact.get((sr, sub), [])
            if keyed_expected:
                return any(text_blank_or_similar(e_idx) for e_idx in keyed_expected)

        if sr is not None:
            sr_only_expected = [e_idx for e_idx in expected_sr.get(sr, []) if _none_or_int(expected[e_idx].get("sub_seq_no")) is None]
            if sr_only_expected:
                return any(text_blank_or_similar(e_idx) for e_idx in sr_only_expected)

        if actual_step_text:
            return any(_step_texts_match(expected_step_text, actual_step_text) for _e_idx, expected_step_text in expected_text)
        return False

    unexpected_actual: list[Record] = []
    if expected:
        for idx, event in enumerate(actual):
            if idx in matched_actual:
                continue
            if actual_is_explained_duplicate(event):
                continue
            unexpected_actual.append(event)

    expected_count = len(expected)
    missing_count = len(missing_expected)
    unexpected_count = len(unexpected_actual)
    score: float | None
    if expected_count == 0:
        score = None
    else:
        score = max(0.0, 1.0 - ((missing_count + unexpected_count) / max(expected_count, 1)))

    return {
        "missing_expected": missing_expected,
        "unexpected_actual": unexpected_actual[:100],
        "delta": {
            "expected_count": expected_count,
            "actual_count": len(actual),
            "missing_count": missing_count,
            "unexpected_count": unexpected_count,
            "score": round(score, 3) if score is not None else None,
        },
    }


def _step_texts_match(expected_text: str, actual_text: str) -> bool:
    if not expected_text or not actual_text:
        return False
    if expected_text == actual_text:
        return True
    # Substring matching keeps compatibility with existing parser behavior.
    if expected_text in actual_text or actual_text in expected_text:
        return True
    # Last-resort token overlap for slightly different wording.
    expected_tokens = set(re.findall(r"[a-z0-9]+", expected_text))
    actual_tokens = set(re.findall(r"[a-z0-9]+", actual_text))
    if not expected_tokens or not actual_tokens:
        return False
    overlap = len(expected_tokens & actual_tokens)
    return overlap >= max(3, min(len(expected_tokens), len(actual_tokens)) * 0.65)


# ---------------------------------------------------------------------------
# 5. Public analytics API
# ---------------------------------------------------------------------------

def analyze(conn: sqlite3.Connection, live_summary: dict[str, Any] | None = None) -> dict[str, Any]:
    """
    Build cache-level diagnostics.

    This remains intentionally global. UI-side code can further scope diagnosis
    by active filters/run. The backend here records durable anomalies that are
    useful even before a user picks a specific SP or time window.
    """
    metrics: dict[str, Any] = {
        "cache_rows": conn.execute("SELECT COUNT(*) AS c FROM trace_events").fetchone()["c"],
        "anonymous_rows": conn.execute("SELECT COUNT(*) AS c FROM trace_events WHERE name IS NULL").fetchone()["c"],
        "incomplete_runs": [],
        "step_gaps": [],
        "step_catalog": [],
        "step_coverage": [],
        "slow_gaps": [],
        "rare_paths": [],
        "broken_instrumentation": [],
        "noisy_names": [],
        "recent_error_handlers": [],
    }

    total = max(metrics["cache_rows"], 1)

    # High-volume names are useful as a signal, but kept low severity because
    # heavy logging can be intentional for central workflow procedures.
    for row in conn.execute(
        """
        SELECT COALESCE(name, '<anonymous>') AS name, COUNT(*) AS trace_count,
               MAX(entry_datetime) AS last_seen
        FROM trace_events
        GROUP BY name
        ORDER BY trace_count DESC
        LIMIT 20
        """
    ):
        if row["trace_count"] / total >= 0.35:
            metrics["noisy_names"].append(dict(row))

    # Prefer actual_runs status when run reconstruction exists. Fall back to the
    # older Entered-vs-Completed heuristic when no reconstructed runs are stored.
    if _table_exists(conn, "actual_runs") and _actual_runs_count(conn) > 0:
        for row in conn.execute(
            """
            SELECT name, type, '' AS execution_query,
                   1 AS entered_count, 0 AS completed_count,
                   start_time AS first_seen, end_time AS last_seen,
                   event_count AS trace_count,
                   run_id, status
            FROM actual_runs
            WHERE status IN ('incomplete', 'error', 'orphan')
            ORDER BY end_time DESC
            LIMIT 25
            """
        ):
            metrics["incomplete_runs"].append(dict(row))
    else:
        for row in conn.execute(
            """
            SELECT COALESCE(name, '<anonymous>') AS name, type, execution_query,
                   SUM(CASE WHEN step LIKE '%Entered%' THEN 1 ELSE 0 END) AS entered_count,
                   SUM(CASE WHEN step LIKE '%Completed%' THEN 1 ELSE 0 END) AS completed_count,
                   MIN(entry_datetime) AS first_seen,
                   MAX(entry_datetime) AS last_seen,
                   COUNT(*) AS trace_count
            FROM trace_events
            GROUP BY name, type, execution_query
            HAVING entered_count > completed_count
            ORDER BY last_seen DESC
            LIMIT 25
            """
        ):
            metrics["incomplete_runs"].append(dict(row))

    # Numeric SubSeq gaps are kept as a heuristic only. The authoritative delta
    # should come from compare_expected_to_actual(), because conditional branches
    # can legitimately skip sub-sequences.
    for row in conn.execute(
        """
        SELECT COALESCE(name, '<anonymous>') AS name, type, sr_no,
               MIN(sub_seq_no) AS min_sub, MAX(sub_seq_no) AS max_sub,
               COUNT(DISTINCT sub_seq_no) AS seen_subs,
               COUNT(*) AS trace_count
        FROM trace_events
        WHERE sub_seq_no IS NOT NULL
        GROUP BY name, type, sr_no
        HAVING max_sub - min_sub + 1 > seen_subs
        ORDER BY trace_count DESC
        LIMIT 40
        """
    ):
        record = dict(row)
        record["missing_count"] = (record["max_sub"] - record["min_sub"] + 1) - record["seen_subs"]
        metrics["step_gaps"].append(record)

    for row in conn.execute(
        """
        SELECT COALESCE(name, '<anonymous>') AS name, COALESCE(type, '<null>') AS type,
               sr_no, sub_seq_no, step, COUNT(*) AS trace_count,
               MIN(entry_datetime) AS first_seen, MAX(entry_datetime) AS last_seen
        FROM trace_events
        GROUP BY name, type, sr_no, sub_seq_no, step
        ORDER BY name, type, sr_no, sub_seq_no
        LIMIT 600
        """
    ):
        metrics["step_catalog"].append(dict(row))

    for row in conn.execute(
        """
        SELECT te.name,
               COUNT(DISTINCT te.sr_no || ':' || te.sub_seq_no) AS observed_steps,
               pm.log_ref_count AS expected_log_refs,
               ROUND(COUNT(DISTINCT te.sr_no || ':' || te.sub_seq_no) * 100.0 / NULLIF(pm.log_ref_count, 0), 1) AS coverage_pct,
               MAX(te.entry_datetime) AS last_seen
        FROM trace_events te
        JOIN procedure_metadata pm ON pm.name = te.name
        WHERE te.sr_no IS NOT NULL AND te.sub_seq_no IS NOT NULL
        GROUP BY te.name, pm.log_ref_count
        ORDER BY coverage_pct ASC, observed_steps DESC
        LIMIT 50
        """
    ):
        metrics["step_coverage"].append(dict(row))

    for row in conn.execute(
        """
        WITH ordered AS (
            SELECT name, type, execution_query, step, sr_no, sub_seq_no, entry_datetime,
                   LAG(entry_datetime) OVER (
                       PARTITION BY name, type, execution_query
                       ORDER BY entry_datetime, sr_no, sub_seq_no
                   ) AS previous_time
            FROM trace_events
            WHERE execution_query IS NOT NULL
        )
        SELECT COALESCE(name, '<anonymous>') AS name, COALESCE(type, '<null>') AS type,
               sr_no, sub_seq_no, step,
               ROUND((julianday(entry_datetime) - julianday(previous_time)) * 86400.0, 3) AS gap_seconds,
               entry_datetime
        FROM ordered
        WHERE previous_time IS NOT NULL
          AND (julianday(entry_datetime) - julianday(previous_time)) * 86400.0 > 5
        ORDER BY gap_seconds DESC
        LIMIT 30
        """
    ):
        metrics["slow_gaps"].append(dict(row))

    for row in conn.execute(
        """
        SELECT COALESCE(name, '<anonymous>') AS name, COALESCE(type, '<null>') AS type,
               sr_no, sub_seq_no, step, COUNT(*) AS trace_count, MAX(entry_datetime) AS last_seen
        FROM trace_events
        GROUP BY name, type, sr_no, sub_seq_no, step
        HAVING COUNT(*) <= 2
        ORDER BY last_seen DESC
        LIMIT 40
        """
    ):
        metrics["rare_paths"].append(dict(row))

    for row in conn.execute(
        """
        SELECT te.name, COUNT(*) AS trace_count
        FROM trace_events te
        LEFT JOIN procedure_metadata pm ON pm.name = te.name
        WHERE te.name IS NOT NULL AND (pm.name IS NULL OR pm.found = 0 OR pm.log_ref_count = 0)
        GROUP BY te.name
        ORDER BY trace_count DESC
        LIMIT 30
        """
    ):
        metrics["broken_instrumentation"].append(dict(row))

    for row in conn.execute(
        """
        SELECT name, type, COUNT(*) AS trace_count, MAX(entry_datetime) AS last_seen
        FROM trace_events
        WHERE name LIKE '%API_Error%' OR name LIKE '%Error%' OR type LIKE '%Error%'
        GROUP BY name, type
        ORDER BY trace_count DESC
        LIMIT 25
        """
    ):
        metrics["recent_error_handlers"].append(dict(row))

    anomalies = _build_anomalies(metrics)
    _replace_anomalies(conn, anomalies)
    diagnosis = [_diagnosis_from_anomaly(a) for a in anomalies]

    return {
        "metrics": metrics,
        "anomalies": anomalies,
        "diagnosis": diagnosis,
        "live_summary": live_summary or {},
    }


def _build_anomalies(metrics: dict[str, Any]) -> list[Record]:
    anomalies: list[Record] = []
    if metrics["anonymous_rows"]:
        anomalies.append(
            _anomaly(
                "high",
                "anonymous_trace",
                ANONYMOUS_NAME,
                f"{metrics['anonymous_rows']} cached trace rows have no SP name.",
                {"count": metrics["anonymous_rows"]},
            )
        )
    for item in metrics["incomplete_runs"][:8]:
        status = item.get("status")
        message = f"{item['name']} has an incomplete or unhealthy reconstructed run." if status else f"{item['name']} has Entered rows without matching Completed rows."
        anomalies.append(_anomaly("high", "incomplete_run", item["name"], message, item))
    for item in metrics["step_gaps"][:8]:
        anomalies.append(_anomaly("medium", "skipped_step", item["name"], f"{item['name']} / {item['type']} SrNo {item['sr_no']} has missing SubSeqNo values.", item))
    for item in metrics["broken_instrumentation"][:8]:
        anomalies.append(_anomaly("medium", "broken_instrumentation", item["name"], f"{item['name']} appears in traces but has no usable static log map.", item))
    for item in metrics["noisy_names"][:4]:
        anomalies.append(_anomaly("low", "high_noise", item["name"], f"{item['name']} dominates cached trace volume.", item))
    for item in metrics["slow_gaps"][:6]:
        anomalies.append(_anomaly("medium", "slow_gap", item["name"], f"{item['name']} has a long gap before {item['step']}.", item))
    return anomalies


def _replace_anomalies(conn: sqlite3.Connection, anomalies: list[Record]) -> None:
    if not _table_exists(conn, "anomalies"):
        return
    conn.execute("DELETE FROM anomalies")
    conn.executemany(
        "INSERT INTO anomalies(id, severity, kind, name, message, evidence_json) VALUES (?, ?, ?, ?, ?, ?)",
        [(a["id"], a["severity"], a["kind"], a["name"], a["message"], _json_dumps(a["evidence"])) for a in anomalies],
    )
    conn.commit()


def _diagnosis_from_anomaly(anomaly: Record) -> Record:
    kind = anomaly["kind"]
    obj_id = anomaly["name"] or ANONYMOUS_NAME
    obj_kind = "anonymous" if obj_id == ANONYMOUS_NAME else "procedure"
    next_actions = {
        "anonymous_trace": "Identify and map the calling procedure",
        "incomplete_run": "Check error logs or exception handlers",
        "skipped_step": "Analyze execution flow and conditions",
        "broken_instrumentation": "Map this procedure",
        "high_noise": "Review logging volume or filter trace",
        "slow_gap": "Investigate performance bottleneck",
    }
    return {
        "id": anomaly["id"],
        "severity": anomaly["severity"],
        "title": kind.replace("_", " ").title(),
        "object_id": obj_id,
        "object_kind": obj_kind,
        "reason": anomaly["message"],
        "primary_evidence": anomaly["evidence"],
        "next_action": next_actions.get(kind, "Investigate anomaly"),
        "focus_node_ids": [obj_id],
    }


def graph_payload(conn: sqlite3.Connection) -> dict[str, Any]:
    """Build the graph model consumed by the 3D frontend."""
    proc_rows = conn.execute("SELECT * FROM procedure_metadata ORDER BY name").fetchall()

    counts = {
        row["name"] or ANONYMOUS_NAME: row["trace_count"]
        for row in conn.execute("SELECT name, COUNT(*) AS trace_count FROM trace_events GROUP BY name")
    }

    type_counts: defaultdict[str, dict[str, int]] = defaultdict(dict)
    for row in conn.execute("SELECT name, type, COUNT(*) AS c FROM trace_events GROUP BY name, type"):
        type_counts[row["name"] or ANONYMOUS_NAME][row["type"] or NULL_TYPE] = row["c"]

    node_map: dict[str, Record] = {}
    edges: list[Record] = []
    metadata_names: set[str] = set()

    def add_node(node: Record) -> None:
        _merge_node(node_map, node)

    for row in proc_rows:
        name = row["name"]
        metadata_names.add(name)
        calls = _safe_json_loads(row["calls_json"], [])
        inserts = _safe_json_loads(row["inserts_json"], [])
        updates = _safe_json_loads(row["updates_json"], [])
        reads = _safe_json_loads(row["reads_json"], [])
        steps = load_expected_steps(conn, name)

        kind = _procedure_kind(name)
        add_node(
            {
                "id": name,
                "label": name,
                "kind": kind,
                "shape": "cylinder" if kind == "workflow" else "cone" if kind == "error" else "box",
                "trace_count": counts.get(name, 0),
                "log_ref_count": row["log_ref_count"],
                "step_count": len(steps),
                "types": type_counts.get(name, {}),
                "found": bool(row["found"]),
            }
        )

        for idx, step in enumerate(steps[:80], start=1):
            step_id = f"{name}::step::{idx}"
            add_node(
                {
                    "id": step_id,
                    "label": step.get("step") or f"Step {idx}",
                    "kind": "step",
                    "shape": "thin_box",
                    "parent": name,
                    "sr_no": step.get("sr_no"),
                    "sub_seq_no": step.get("sub_seq_no"),
                    "trace_count": 0,
                    "ordinal": step.get("ordinal") or idx,
                }
            )
            edges.append({"source": name, "target": step_id, "kind": "static_step", "weight": 1})

        _add_table_edges(add_node, edges, name, inserts[:30], "table_write", "writes")
        _add_table_edges(add_node, edges, name, updates[:30], "table_update", "updates")
        _add_table_edges(add_node, edges, name, reads[:20], "table_read", "reads", reverse=True)

        # Add placeholder nodes for called procedures not otherwise present.
        # Without this, frontend edge rendering silently drops call edges whose
        # target has no node in metadata/cache.
        for call in calls[:20]:
            if not call:
                continue
            add_node(
                {
                    "id": call,
                    "label": call,
                    "kind": _procedure_kind(call) if call in metadata_names else "unknown",
                    "shape": "box",
                    "trace_count": counts.get(call, 0),
                    "types": type_counts.get(call, {}),
                    "found": call in metadata_names,
                    "roles": ["procedure_call_target"],
                }
            )
            edges.append({"source": name, "target": call, "kind": "calls", "weight": 1})

    # Add trace-only nodes that are absent from static metadata.
    for row in conn.execute("SELECT COALESCE(name, '<anonymous>') AS name, COUNT(*) AS c FROM trace_events GROUP BY name"):
        if row["name"] not in metadata_names and row["name"] not in node_map:
            kind = "anonymous" if row["name"] == ANONYMOUS_NAME else "unknown"
            add_node({"id": row["name"], "label": row["name"], "kind": kind, "shape": "octahedron", "trace_count": row["c"], "found": False})

    _enrich_graph_nodes_and_edges(conn, node_map, edges)
    default_focus = _default_focus(node_map, edges)
    return {"nodes": list(node_map.values()), "edges": edges, "default_focus": default_focus}


def _merge_node(node_map: dict[str, Record], node: Record) -> None:
    existing = node_map.get(node["id"])
    if not existing:
        node["roles"] = sorted(set(node.get("roles", [node.get("kind", "unknown")])))
        node_map[node["id"]] = node
        return

    roles = set(existing.get("roles", [existing.get("kind", "unknown")]))
    roles.update(node.get("roles", [node.get("kind", "unknown")]))
    existing["roles"] = sorted(roles)
    existing["trace_count"] = max(existing.get("trace_count", 0) or 0, node.get("trace_count", 0) or 0)
    existing["types"] = existing.get("types") or node.get("types") or {}
    existing["found"] = bool(existing.get("found") or node.get("found"))

    old_kind = str(existing.get("kind", "unknown"))
    new_kind = str(node.get("kind", "unknown"))
    if old_kind.startswith("table") and new_kind.startswith("table"):
        existing["kind"] = min([old_kind, new_kind], key=_table_kind_rank)
    elif old_kind in {"unknown", "table_read"} and new_kind not in {"unknown"}:
        existing["kind"] = new_kind


def _table_kind_rank(kind: str) -> int:
    return TABLE_KIND_PRIORITY.index(kind) if kind in TABLE_KIND_PRIORITY else 99


def _procedure_kind(name: str) -> str:
    if name.upper().startswith("XSTUDIO_WORKFLOW"):
        return "workflow"
    if "API_Error" in name or "Error" in name:
        return "error"
    return "procedure"


def _add_table_edges(add_node, edges: list[Record], source_name: str, tables: Iterable[Any], table_kind: str, edge_kind: str, reverse: bool = False) -> None:
    for table in tables:
        if not meaningful_table_name(table):
            continue
        tid = f"table::{table}"
        add_node({"id": tid, "label": table, "kind": table_kind, "shape": "slab", "trace_count": 0, "roles": [table_kind]})
        if reverse:
            edges.append({"source": tid, "target": source_name, "kind": edge_kind, "weight": 1})
        else:
            edges.append({"source": source_name, "target": tid, "kind": edge_kind, "weight": 1})


def _enrich_graph_nodes_and_edges(conn: sqlite3.Connection, node_map: dict[str, Record], edges: list[Record]) -> None:
    broken_names = _broken_instrumentation_names(conn)
    max_trace_count = max((node.get("trace_count") or 0 for node in node_map.values()), default=1) or 1

    degree_map: defaultdict[str, int] = defaultdict(int)
    for edge in edges:
        degree_map[edge["source"]] += 1
        degree_map[edge["target"]] += 1

    dominant_id = _select_dominant_node(node_map)
    for node in node_map.values():
        kind = str(node.get("kind", "unknown"))
        display_label = readable_node_label(node)
        node["display_label"] = display_label[:48]
        node["short_label"] = display_label[:34]
        node["lane"] = _node_lane(kind)
        node["importance"] = round((node.get("trace_count") or 0) / max_trace_count, 4)
        node["severity"] = "high" if kind in {"error", "unknown"} else "medium" if kind == "anonymous" else "low"
        node["is_damage"] = kind in {"error", "anonymous", "unknown"} or node.get("id", "") in broken_names
        node["degree"] = degree_map.get(node["id"], 0)
        node["is_dominant"] = node["id"] == dominant_id

    for edge in edges:
        kind = edge.get("kind", "")
        edge["priority"] = EDGE_PRIORITY.get(kind, 0)
        edge["style"] = "strong" if kind in STRONG_EDGE_KINDS else "normal" if kind == "reads" else "weak"
        edge["label"] = EDGE_LABELS.get(kind, kind)
        edge["evidence_type"] = "static"


def _broken_instrumentation_names(conn: sqlite3.Connection) -> set[str]:
    rows = conn.execute(
        """
        SELECT te.name
        FROM trace_events te
        LEFT JOIN procedure_metadata pm ON pm.name = te.name
        WHERE te.name IS NOT NULL AND (pm.name IS NULL OR pm.found = 0 OR pm.log_ref_count = 0)
        GROUP BY te.name
        """
    ).fetchall()
    return {row["name"] for row in rows}


def _node_lane(kind: str) -> str:
    if kind.startswith("table"):
        return "table"
    if kind in {"procedure", "workflow", "step", "error", "unknown", "anonymous"}:
        return kind
    return "unknown"


def _select_dominant_node(node_map: dict[str, Record]) -> str | None:
    """Prefer the highest-volume known procedure over noisy unknown/anonymous."""
    known = [node for node in node_map.values() if node.get("kind") in {"procedure", "workflow", "error"} and node.get("found", True)]
    pool = known or list(node_map.values())
    if not pool:
        return None
    return max(pool, key=lambda n: (n.get("trace_count") or 0, n.get("degree") or 0, str(n.get("id") or ""))).get("id")


def _default_focus(node_map: dict[str, Record], edges: list[Record]) -> Record:
    dominant_id = _select_dominant_node(node_map)
    connected_ids: list[str] = []
    if dominant_id is not None:
        for edge in edges:
            if edge["source"] == dominant_id and edge["target"] != dominant_id:
                connected_ids.append(edge["target"])
            elif edge["target"] == dominant_id and edge["source"] != dominant_id:
                connected_ids.append(edge["source"])
    return {
        "node_id": dominant_id,
        "reason": "dominant_known_trace_volume",
        "connected_node_ids": sorted(set(connected_ids)),
    }


def playback_payload(conn: sqlite3.Connection, filters: dict[str, Any]) -> dict[str, Any]:
    """Return playback comparison for either a selected run or filter context."""
    run_id = filters.get("run_id")
    if run_id:
        actual = _load_actual_events_for_run(conn, str(run_id))
        # Derive context from the run's actual events if the caller did not pass it.
        if actual:
            filters.setdefault("name", actual[0].get("name"))
            filters.setdefault("type", actual[0].get("type"))
    else:
        actual = _load_actual_events_for_filters(conn, filters)

    expected_name = filters.get("name") or (actual[0].get("name") if actual else None)
    expected = load_expected_steps(conn, expected_name)
    comparison = compare_expected_to_actual(expected, actual)
    transitions = learned_transitions(conn, expected_name, filters.get("type"))
    parameter_profiles = parameter_intelligence(actual)

    return {
        "expected": expected,
        "actual": actual,
        "expected_unavailable": expected_path_unavailable(expected_name, expected),
        "missing_expected": comparison["missing_expected"],
        "unexpected_actual": comparison["unexpected_actual"],
        "transitions": transitions,
        "parameter_profiles": parameter_profiles,
        "delta": comparison["delta"],
        "actual_truncated": False,
        "actual_total_count": len(actual),
        "actual_returned_count": len(actual),
        "expected_source": expected[0].get("source") if expected else None,
        "context_run_id": str(run_id) if run_id else None,
    }


# ---------------------------------------------------------------------------
# 6. Learned transitions and parameter intelligence
# ---------------------------------------------------------------------------

def learned_transitions(conn: sqlite3.Connection, name: str | None, type_name: str | None) -> list[Record]:
    clauses = ["execution_query IS NOT NULL"]
    values: list[Any] = []
    if name:
        clauses.append("name = ?")
        values.append(name)
    if type_name:
        clauses.append("type = ?")
        values.append(type_name)
    where = f"WHERE {' AND '.join(clauses)}"
    rows = conn.execute(
        f"""
        WITH ordered AS (
            SELECT name, type, execution_query,
                   COALESCE(step, 'step') || ' [' || COALESCE(sr_no, -1) || '.' || COALESCE(sub_seq_no, -1) || ']' AS node,
                   LEAD(COALESCE(step, 'step') || ' [' || COALESCE(sr_no, -1) || '.' || COALESCE(sub_seq_no, -1) || ']')
                     OVER (PARTITION BY name, type, execution_query ORDER BY entry_datetime, sr_no, sub_seq_no) AS next_node
            FROM trace_events
            {where}
        )
        SELECT node, next_node, COUNT(*) AS count
        FROM ordered
        WHERE next_node IS NOT NULL
        GROUP BY node, next_node
        ORDER BY count DESC
        LIMIT 60
        """,
        values,
    ).fetchall()
    return _dicts(rows)


def parameter_intelligence(events: list[Record]) -> dict[str, Any]:
    key_counts: dict[str, int] = {}
    samples: list[Record] = []
    for event in events[:250]:
        params = parse_exec_params(event.get("execution_query") or "")
        for key in params:
            key_counts[key] = key_counts.get(key, 0) + 1
        if params:
            samples.append({"id": event.get("id"), "name": event.get("name"), "type": event.get("type"), "params": params})

    common_keys = sorted(key_counts.items(), key=lambda item: item[1], reverse=True)
    dominant = {key for key, count in common_keys if count >= max(2, len(samples) * 0.5)}
    outliers: list[Record] = []
    for sample in samples:
        missing = sorted(dominant - set(sample["params"].keys()))
        extra = sorted(set(sample["params"].keys()) - dominant)
        if missing or len(extra) > 3:
            outliers.append({**sample, "missing_common_params": missing, "extra_params": extra[:12]})

    return {"common_params": common_keys[:30], "outliers": outliers[:30]}


def parse_exec_params(query: str) -> dict[str, str]:
    """
    Parse simple SQL execution parameters from strings such as:
    EXEC dbo.Proc @HeatNo='123', @Mode = 1
    """
    params: dict[str, str] = {}
    for match in re.finditer(r"@([A-Za-z0-9_]+)\s*=\s*(?:'([^']*)'|([^,\s]+))", query or ""):
        params[match.group(1)] = match.group(2) if match.group(2) is not None else match.group(3)
    return params


def normal_step(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "").lower()).strip()


# ---------------------------------------------------------------------------
# 7. Expected-path graph endpoint helper
# ---------------------------------------------------------------------------

def expected_path_payload(conn: sqlite3.Connection, name: str) -> dict[str, Any]:
    """Return expected path and a compact graph using the canonical loader."""
    steps = load_expected_steps(conn, name)

    nodes: list[Record] = [
        {"id": name, "label": name, "kind": "procedure", "shape": "box", "lane": "procedure"}
    ]
    edges: list[Record] = []

    for step in steps:
        ordinal = step.get("ordinal") or len(nodes)
        step_id = f"{name}::expected::{ordinal}"
        nodes.append(
            {
                "id": step_id,
                "label": step.get("step"),
                "kind": step.get("kind") or "step",
                "shape": "thin_box",
                "lane": "step",
                "parent": name,
                "sr_no": step.get("sr_no"),
                "sub_seq_no": step.get("sub_seq_no"),
                "ordinal": ordinal,
            }
        )
        edges.append({"source": name, "target": step_id, "kind": "static_step", "weight": 1, "priority": EDGE_PRIORITY["static_step"]})

        for table in step.get("tables") or []:
            if not meaningful_table_name(table):
                continue
            tid = f"table::{table}"
            nodes.append({"id": tid, "label": table, "kind": "table_write", "shape": "slab", "lane": "table"})
            edges.append({"source": step_id, "target": tid, "kind": "writes", "weight": 1, "priority": EDGE_PRIORITY["writes"]})

        for call in step.get("calls") or []:
            nodes.append({"id": call, "label": call, "kind": "procedure", "shape": "box", "lane": "procedure"})
            edges.append({"source": step_id, "target": call, "kind": "calls", "weight": 1, "priority": EDGE_PRIORITY["calls"]})

    return {
        "name": name,
        "steps": steps,
        "expected_unavailable": expected_path_unavailable(name, steps),
        "graph": {"nodes": _dedupe_nodes(nodes), "edges": edges},
    }


def _dedupe_nodes(nodes: list[Record]) -> list[Record]:
    seen: set[str] = set()
    unique: list[Record] = []
    for node in nodes:
        node_id = str(node.get("id"))
        if node_id in seen:
            continue
        seen.add(node_id)
        unique.append(node)
    return unique


# ---------------------------------------------------------------------------
# 8. Run reconstruction and run detail API
# ---------------------------------------------------------------------------

def reconstruct_and_save_runs(conn: sqlite3.Connection, start_time: str | None = None) -> int:
    """
    Reconstruct unassigned trace rows into approximate actual runs.

    This is necessarily heuristic because the trace table does not expose a true
    transaction/session key. The logic is conservative:
    - group by name/type/execution_query first,
    - split when the time gap is large,
    - also split when a Completed/End marker is followed by a new Enter/Start,
    - tolerate NULL step text and timestamps without milliseconds.
    """
    if not (_table_exists(conn, "actual_runs") and _table_exists(conn, "actual_run_events")):
        return 0

    start_clause = "AND e.entry_datetime >= ?" if start_time else ""
    params = [start_time] if start_time else []
    rows = conn.execute(
        f"""
        SELECT e.*
        FROM trace_events e
        LEFT JOIN actual_run_events re ON re.event_id = e.id
        WHERE re.run_id IS NULL
          AND e.name IS NOT NULL
          {start_clause}
        ORDER BY e.name, e.type, e.execution_query, e.entry_datetime, e.id
        """,
        params,
    ).fetchall()
    events = _dicts(rows)
    if not events:
        return 0

    grouped: defaultdict[tuple[Any, Any, str], list[Record]] = defaultdict(list)
    for event in events:
        key = (event.get("name"), event.get("type"), event.get("execution_query") or "")
        grouped[key].append(event)

    runs_to_insert: list[tuple[Any, ...]] = []
    events_to_insert: list[tuple[str, Any]] = []
    run_events_by_id: dict[str, list[Record]] = {}

    for key, group_events in grouped.items():
        group_events.sort(key=lambda event: (_dt_sort_key(event.get("entry_datetime")), _safe_int(event.get("sr_no"), 0), _safe_int(event.get("sub_seq_no"), 0), _safe_int(event.get("id"), 0)))
        current: list[Record] = []
        previous_was_terminal = False

        for event in group_events:
            if current:
                prev = current[-1]
                gap = _date_diff_seconds(prev.get("entry_datetime"), event.get("entry_datetime"))
                starts_new = previous_was_terminal and _is_start_step(event.get("step"))
                sr_reset = _looks_like_sequence_reset(prev, event)
                if gap > RUN_SPLIT_SECONDS or starts_new or sr_reset:
                    row, run_id = _finalize_run(key, current, events_to_insert)
                    runs_to_insert.append(row)
                    run_events_by_id[run_id] = list(current)
                    current = []
            current.append(event)
            previous_was_terminal = _is_terminal_step(event.get("step"))

        if current:
            row, run_id = _finalize_run(key, current, events_to_insert)
            runs_to_insert.append(row)
            run_events_by_id[run_id] = list(current)

    if not runs_to_insert:
        return 0

    before = conn.in_transaction
    savepoint_active = False
    try:
        conn.execute("SAVEPOINT analyzer_reconstruct_runs")
        savepoint_active = True
        conn.executemany(
            """
            INSERT INTO actual_runs
            (run_id, name, type, execution_query_hash, parameter_signature, start_time, end_time, duration_ms, status, event_count, error_count)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            runs_to_insert,
        )
        conn.executemany("INSERT INTO actual_run_events (run_id, event_id) VALUES (?, ?)", events_to_insert)

        if _table_exists(conn, "run_deltas"):
            deltas_to_insert: list[tuple[Any, ...]] = []
            for row in runs_to_insert:
                run_id, name, _type_name, *_rest = row
                delta = analyze_run_delta(conn, run_id, name, run_events_by_id.get(run_id, []))
                deltas_to_insert.append(
                    (
                        run_id,
                        delta["missing_count"],
                        delta["unexpected_count"],
                        _storage_score_for_run_delta(conn, delta["score"]),
                        _json_dumps(delta["delta_json"]),
                    )
                )
            conn.executemany(
                """
                INSERT INTO run_deltas (run_id, missing_count, unexpected_count, score, delta_json)
                VALUES (?, ?, ?, ?, ?)
                """,
                deltas_to_insert,
            )
        conn.execute("RELEASE SAVEPOINT analyzer_reconstruct_runs")
        savepoint_active = False
        if not before:
            conn.commit()
    except Exception:
        if savepoint_active:
            conn.execute("ROLLBACK TO SAVEPOINT analyzer_reconstruct_runs")
            conn.execute("RELEASE SAVEPOINT analyzer_reconstruct_runs")
        if not before:
            conn.rollback()
        raise

    return len(runs_to_insert)


def _finalize_run(key: tuple[Any, Any, str], events: list[Record], events_to_insert: list[tuple[str, Any]]) -> tuple[tuple[Any, ...], str]:
    """Build one actual_runs insert row and append its event mappings."""
    name, type_name, query = key
    run_id = str(uuid.uuid4())

    start_text = events[0].get("entry_datetime")
    end_text = events[-1].get("entry_datetime")
    t_start = _parse_dt(start_text)
    t_end = _parse_dt(end_text)
    duration_ms = int((t_end - t_start).total_seconds() * 1000) if t_start and t_end else 0

    steps = [str(event.get("step") or "").lower() for event in events]
    has_start = any("enter" in step or "start" in step for step in steps)
    has_end = any("complet" in step or "end" in step for step in steps)
    has_error = any("error" in step or "fail" in step for step in steps)

    status = "unknown"
    if has_error:
        status = "error"
    elif has_start and has_end:
        status = "complete"
    elif has_start and not has_end:
        status = "incomplete"
    elif not has_start and has_end:
        status = "orphan"

    params = parse_exec_params(query)
    signature_text = "&".join(f"{key}={value}" for key, value in sorted(params.items()))
    signature = hashlib.sha1(signature_text.encode("utf-8")).hexdigest()[:16] if signature_text else "none"
    query_hash = hashlib.sha1(query.encode("utf-8")).hexdigest()[:16]

    for event in events:
        events_to_insert.append((run_id, event["id"]))

    row = (
        run_id,
        name,
        type_name,
        query_hash,
        signature,
        start_text,
        end_text,
        duration_ms,
        status,
        len(events),
        sum(1 for step in steps if "error" in step or "fail" in step),
    )
    return row, run_id


def _is_start_step(step: Any) -> bool:
    text = normal_step(step)
    return "enter" in text or "start" in text


def _is_terminal_step(step: Any) -> bool:
    text = normal_step(step)
    return "complet" in text or "end" in text or "error" in text or "fail" in text


def _looks_like_sequence_reset(previous: Record, current: Record) -> bool:
    prev_sr = _none_or_int(previous.get("sr_no"))
    curr_sr = _none_or_int(current.get("sr_no"))
    prev_sub = _none_or_int(previous.get("sub_seq_no"))
    curr_sub = _none_or_int(current.get("sub_seq_no"))
    if prev_sr is None or curr_sr is None:
        return False
    if curr_sr < prev_sr:
        return True
    if curr_sr == prev_sr and prev_sub is not None and curr_sub is not None and curr_sub < prev_sub:
        return True
    return False


def get_runs(conn: sqlite3.Connection, params: dict[str, Any]) -> list[Record]:
    """List reconstructed runs, using overlap logic for time-window filters."""
    if not _table_exists(conn, "actual_runs"):
        return []

    limit = _safe_limit(params.get("limit"), 200, 1000)
    clauses: list[str] = []
    values: list[Any] = []
    if params.get("name"):
        clauses.append("name = ?")
        values.append(params["name"])
    if params.get("type"):
        clauses.append("type = ?")
        values.append(params["type"])
    if params.get("start"):
        clauses.append("end_time >= ?")
        values.append(params["start"])
    if params.get("end"):
        clauses.append("start_time <= ?")
        values.append(params["end"])
    if params.get("status"):
        clauses.append("status = ?")
        values.append(params["status"])

    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    rows = conn.execute(
        f"SELECT * FROM actual_runs {where} ORDER BY start_time DESC LIMIT ?",
        [*values, limit],
    ).fetchall()
    return _dicts(rows)


def get_run_detail(conn: sqlite3.Connection, run_id: str) -> Record:
    if not _table_exists(conn, "actual_runs"):
        return {}

    row = conn.execute("SELECT * FROM actual_runs WHERE run_id = ?", (run_id,)).fetchone()
    if not row:
        return {}
    run = dict(row)

    if _table_exists(conn, "run_deltas"):
        delta_row = conn.execute("SELECT * FROM run_deltas WHERE run_id = ?", (run_id,)).fetchone()
        if delta_row:
            details = _safe_json_loads(delta_row["delta_json"], {})
            expected_unavailable = bool(details.get("expected_unavailable"))
            run["delta"] = {
                "missing_count": delta_row["missing_count"],
                "unexpected_count": delta_row["unexpected_count"],
                "score": None if expected_unavailable else delta_row["score"],
                "expected_unavailable": expected_unavailable,
                "details": details,
            }

    run["events"] = _load_actual_events_for_run(conn, run_id)
    return run


def analyze_run_delta(conn: sqlite3.Connection, run_id: str, name: str, events: list[Record]) -> Record:
    expected = load_expected_steps(conn, name)
    comparison = compare_expected_to_actual(expected, events)
    delta = comparison["delta"]
    unavailable = expected_path_unavailable(name, expected)

    return {
        "run_id": run_id,
        "missing_count": delta["missing_count"],
        "unexpected_count": delta["unexpected_count"],
        "score": delta["score"],
        "expected_unavailable": unavailable,
        "delta_json": {
            "expected_unavailable": unavailable,
            "expected_source": expected[0].get("source") if expected else None,
            "expected_count": delta["expected_count"],
            "actual_count": delta["actual_count"],
            "score": delta["score"],
            "missing": comparison["missing_expected"],
            "unexpected": comparison["unexpected_actual"],
        },
    }


# ---------------------------------------------------------------------------
# 9. Presentation helpers
# ---------------------------------------------------------------------------

def readable_node_label(node: dict[str, Any]) -> str:
    label = str(node.get("label") or node.get("id") or "")
    kind = node.get("kind")
    if kind == "step":
        prefix = ""
        if node.get("sr_no") is not None:
            prefix = f"{node.get('sr_no')}"
            if node.get("sub_seq_no") is not None:
                prefix += f".{node.get('sub_seq_no')}"
            prefix += " "
        return f"{prefix}{label}".strip()

    if kind and str(kind).startswith("table"):
        label = re.sub(r"^table::", "", label, flags=re.IGNORECASE)
    label = re.sub(r"^\[?dbo\]?\.", "", label, flags=re.IGNORECASE)
    label = re.sub(r"^(XStudio_Xbatch\.dbo\.|XStudio_|XSTUDIO_)", "", label, flags=re.IGNORECASE)
    label = re.sub(r"^XMES_I_", "", label, flags=re.IGNORECASE)
    label = re.sub(r"^XMES_", "", label, flags=re.IGNORECASE)
    label = re.sub(r"(_Usp|_USP|_SP)$", "", label, flags=re.IGNORECASE)
    label = re.sub(r"^WORKFLOW_", "Workflow ", label, flags=re.IGNORECASE)
    label = re.sub(r"_+", " ", label)
    return re.sub(r"\s+", " ", label).strip() or str(node.get("label") or node.get("id") or "")


def meaningful_table_name(value: Any) -> bool:
    name = readable_node_label({"kind": "table_read", "label": value}).lower()
    return bool(name and name not in {"dbo", "cur", "api", "batch", "table"})


def _anomaly(severity: str, kind: str, name: str | None, message: str, evidence: dict[str, Any]) -> Record:
    raw = f"{severity}|{kind}|{name}|{message}|{_json_dumps(evidence)}"
    return {
        "id": hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16],
        "severity": severity,
        "kind": kind,
        "name": name,
        "message": message,
        "evidence": evidence,
    }
