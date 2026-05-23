from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
WEB_ROOT = ROOT / "web"
DATA_ROOT = ROOT / "data"
DB_PATH = DATA_ROOT / "tracer.sqlite"
SP_DOC_PATH = ROOT / "Xstudio_Xbatch_StoredProcedures_2026-05-22_09-18-05.md"
SCHEMA_DOC_PATH = ROOT / "Xstudio_Xbatch_Schema_2026-05-22_09-15-29.md"

TRACE_VIEW = "dbo.XStudio_List_XMES_Log_Trn_Tbl_Vw"
TRACE_DATABASE = os.environ.get("TRACER_SQL_DATABASE", "XStudio_Xbatch")


@dataclass(frozen=True)
class SqlConfig:
    server: str
    user: str
    password: str
    database: str
    sqlcmd: str = "sqlcmd"
    timeout_seconds: int = 30

    @property
    def configured(self) -> bool:
        return bool(self.server and self.user and self.password and self.database)


def sql_config() -> SqlConfig:
    return SqlConfig(
        server=os.environ.get("TRACER_SQL_SERVER") or os.environ.get("MSSQL_MCP_SERVER", ""),
        user=os.environ.get("TRACER_SQL_USER") or os.environ.get("MSSQL_MCP_USER", ""),
        password=os.environ.get("TRACER_SQL_PASSWORD") or os.environ.get("MSSQL_MCP_PASSWORD", ""),
        database=TRACE_DATABASE,
        sqlcmd=os.environ.get("TRACER_SQLCMD", "sqlcmd"),
        timeout_seconds=int(os.environ.get("TRACER_SQL_TIMEOUT", "30")),
    )


def ensure_dirs() -> None:
    DATA_ROOT.mkdir(parents=True, exist_ok=True)

