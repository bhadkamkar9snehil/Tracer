from __future__ import annotations

import json
import os
import subprocess
from dataclasses import dataclass
from typing import Any

from .config import SqlConfig, TRACE_VIEW


class SqlClientError(RuntimeError):
    pass


@dataclass
class SqlClient:
    config: SqlConfig

    def _run(self, sql: str, timeout: int | None = None) -> str:
        if not self.config.configured:
            raise SqlClientError("SQL config is incomplete. Set TRACER_SQL_* or MSSQL_MCP_* environment variables.")

        timeout_seconds = timeout or self.config.timeout_seconds
        cmd = [
            self.config.sqlcmd,
            "-S",
            self.config.server,
            "-d",
            self.config.database,
            "-U",
            self.config.user,
            "-C",
            "-b",
            "-r",
            "1",
            "-w",
            "65535",
            "-y",
            "0",
            "-Y",
            "0",
            "-Q",
            f"SET NOCOUNT ON; {sql}",
        ]
        env = os.environ.copy()
        env["SQLCMDPASSWORD"] = self.config.password
        try:
            proc = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=timeout_seconds,
                encoding="utf-8",
                errors="replace",
                env=env,
            )
        except subprocess.TimeoutExpired as exc:
            raise SqlClientError(
                f"SQL command timed out after {timeout_seconds} seconds while querying "
                f"{self.config.server}/{self.config.database}. Check network/VPN/SQL availability or reduce the sync limit."
            ) from exc
        except FileNotFoundError as exc:
            raise SqlClientError(f"SQL command runner not found: {self.config.sqlcmd}") from exc
        if proc.returncode != 0:
            raise SqlClientError(_sanitize_sql_message((proc.stderr or proc.stdout).strip(), self.config))
        return proc.stdout.strip()

    def query_json(self, select_sql: str, timeout: int | None = None) -> list[dict[str, Any]]:
        sql = f"{select_sql.rstrip().rstrip(';')} FOR JSON PATH, INCLUDE_NULL_VALUES;"
        raw = self._run(sql, timeout=timeout)
        payload = "".join(line.strip() for line in raw.splitlines() if line.strip())
        first_array = payload.find("[")
        first_object = payload.find("{")
        starts = [idx for idx in (first_array, first_object) if idx >= 0]
        if starts:
            payload = payload[min(starts) :]
        if not payload:
            return []
        try:
            return json.loads(payload)
        except json.JSONDecodeError as exc:
            raise SqlClientError(f"SQL JSON parse failed: {exc}") from exc

    def trace_columns(self) -> list[dict[str, Any]]:
        return self.query_json(
            """
            SELECT c.column_id, c.name, t.name AS type_name, c.max_length, c.is_nullable
            FROM sys.columns c
            JOIN sys.types t ON c.user_type_id = t.user_type_id
            WHERE c.object_id = OBJECT_ID('dbo.XStudio_List_XMES_Log_Trn_Tbl_Vw')
            ORDER BY c.column_id
            """
        )

    def trace_overview(self) -> list[dict[str, Any]]:
        return self.query_json(
            f"""
            SELECT
                COUNT_BIG(*) AS total_rows,
                COUNT(DISTINCT Name) AS unique_names,
                SUM(CASE WHEN Name IS NULL THEN 1 ELSE 0 END) AS anonymous_rows,
                MIN(EntryDateTime) AS first_seen,
                MAX(EntryDateTime) AS last_seen
            FROM {TRACE_VIEW} WITH (NOLOCK)
            """
        )

    def top_names(self, limit: int = 50) -> list[dict[str, Any]]:
        return self.query_json(
            f"""
            SELECT TOP ({int(limit)})
                COALESCE(Name, '<anonymous>') AS name,
                COUNT_BIG(*) AS trace_count,
                MIN(EntryDateTime) AS first_seen,
                MAX(EntryDateTime) AS last_seen
            FROM {TRACE_VIEW} WITH (NOLOCK)
            GROUP BY Name
            ORDER BY trace_count DESC
            """
        )

    def type_counts(self) -> list[dict[str, Any]]:
        return self.query_json(
            f"""
            SELECT COALESCE(Type, '<null>') AS type, COUNT_BIG(*) AS trace_count
            FROM {TRACE_VIEW} WITH (NOLOCK)
            GROUP BY Type
            ORDER BY trace_count DESC
            """
        )

    def step_counts(self, limit: int = 250) -> list[dict[str, Any]]:
        return self.query_json(
            f"""
            SELECT TOP ({int(limit)})
                COALESCE(Name, '<anonymous>') AS name,
                COALESCE(Type, '<null>') AS type,
                SrNo AS sr_no,
                SubSeqNo AS sub_seq_no,
                Step AS step,
                COUNT_BIG(*) AS trace_count,
                MIN(EntryDateTime) AS first_seen,
                MAX(EntryDateTime) AS last_seen
            FROM {TRACE_VIEW} WITH (NOLOCK)
            GROUP BY Name, Type, SrNo, SubSeqNo, Step
            ORDER BY trace_count DESC
            """
        )

    def recent_events(self, limit: int = 250) -> list[dict[str, Any]]:
        return self.filtered_events({"limit": limit})

    def filtered_events(self, filters: dict[str, Any]) -> list[dict[str, Any]]:
        limit = max(1, min(int(filters.get("limit") or 250), 5000))
        clauses: list[str] = []
        if filters.get("name"):
            if filters["name"] == "<anonymous>":
                clauses.append("Name IS NULL")
            else:
                clauses.append(f"Name = '{_sql_literal(filters['name'])}'")
        if filters.get("type"):
            if filters["type"] == "<null>":
                clauses.append("Type IS NULL")
            else:
                clauses.append(f"Type = '{_sql_literal(filters['type'])}'")
        if filters.get("start"):
            clauses.append(f"EntryDateTime >= CONVERT(datetime, '{_sql_literal(filters['start'])}', 121)")
            clauses.append(f"ReportDate >= CONVERT(date, '{_sql_literal(filters['start'])}', 121)")
        if filters.get("end"):
            clauses.append(f"EntryDateTime <= CONVERT(datetime, '{_sql_literal(filters['end'])}', 121)")
            clauses.append(f"ReportDate <= CONVERT(date, '{_sql_literal(filters['end'])}', 121)")
        if filters.get("sr_no") not in (None, ""):
            clauses.append(f"SrNo = {int(filters['sr_no'])}")
        if filters.get("sub_seq_no") not in (None, ""):
            clauses.append(f"SubSeqNo = {int(filters['sub_seq_no'])}")
        if filters.get("step"):
            clauses.append(f"Step LIKE '%{_sql_like(filters['step'])}%'")
        if filters.get("q"):
            needle = _sql_like(filters["q"])
            clauses.append(
                f"(Step LIKE '%{needle}%' OR CONVERT(nvarchar(max), ExecutionQuery) LIKE '%{needle}%' OR CONVERT(varchar(max), Details) LIKE '%{needle}%')"
            )
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        return self.query_json(
            f"""
            SELECT TOP ({limit})
                ID AS id,
                CONVERT(varchar(10), ReportDate, 23) AS report_date,
                CONVERT(varchar(23), EntryDateTime, 121) AS entry_datetime,
                Name AS name,
                Type AS type,
                Step AS step,
                SrNo AS sr_no,
                SubSeqNo AS sub_seq_no,
                LEFT(CONVERT(nvarchar(max), ExecutionQuery), 1000) AS execution_query,
                LEFT(CONVERT(varchar(max), Details), 1000) AS details
            FROM {TRACE_VIEW} WITH (NOLOCK)
            {where}
            ORDER BY EntryDateTime DESC, ID DESC
            """,
            timeout=max(self.config.timeout_seconds, 60),
        )

    def events_after(self, watermark: str | None, limit: int = 5000) -> list[dict[str, Any]]:
        if watermark:
            where = f"WHERE EntryDateTime > CONVERT(datetime, '{watermark}', 121)"
            order = "ORDER BY EntryDateTime ASC, ID ASC"
        else:
            where = ""
            order = "ORDER BY EntryDateTime DESC, ID DESC"
        return self.query_json(
            f"""
            SELECT TOP ({int(limit)})
                ID AS id,
                CONVERT(varchar(10), ReportDate, 23) AS report_date,
                CONVERT(varchar(23), EntryDateTime, 121) AS entry_datetime,
                Name AS name,
                Type AS type,
                Step AS step,
                SrNo AS sr_no,
                SubSeqNo AS sub_seq_no,
                LEFT(CONVERT(nvarchar(max), ExecutionQuery), 2000) AS execution_query,
                LEFT(CONVERT(varchar(max), Details), 2000) AS details
            FROM {TRACE_VIEW} WITH (NOLOCK)
            {where}
            {order}
            """,
            timeout=max(self.config.timeout_seconds, 90),
        )


def _sql_literal(value: Any) -> str:
    return str(value).replace("'", "''")


def _sql_like(value: Any) -> str:
    return _sql_literal(value).replace("[", "[[]").replace("%", "[%]").replace("_", "[_]")


def _sanitize_sql_message(message: str, config: SqlConfig) -> str:
    if not message:
        return "SQL command failed without an error message."
    sanitized = message
    if config.password:
        sanitized = sanitized.replace(config.password, "<redacted>")
    return sanitized
