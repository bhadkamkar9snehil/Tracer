from __future__ import annotations

import argparse
import json
import mimetypes
import time
from collections import deque
from datetime import datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from tracer import analyzer, atlas, cache, parsers
from tracer.config import DB_PATH, SCHEMA_DOC_PATH, SP_DOC_PATH, WEB_ROOT, sql_config
from tracer.sql_client import SqlClient, SqlClientError


PORT = 8765
RUNTIME_LOG: deque[dict] = deque(maxlen=300)
STARTED_AT = datetime.now().astimezone().isoformat(timespec="seconds")


class TracerServer(SimpleHTTPRequestHandler):
    server_version = "TracerHTTP/0.1"

    def translate_path(self, path: str) -> str:
        parsed = urlparse(path)
        route = parsed.path
        if route == "/":
            return str(WEB_ROOT / "index.html")
        return str(WEB_ROOT / route.lstrip("/"))

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/"):
            self.handle_api("GET", parsed.path, parse_qs(parsed.query))
            return
        super().do_GET()

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/"):
            self.handle_api("POST", parsed.path, parse_qs(parsed.query))
            return
        self.send_error(404)

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def handle_api(self, method: str, path: str, query: dict[str, list[str]]) -> None:
        started = time.perf_counter()
        conn = cache.connect()
        cache.init_db(conn)
        client = SqlClient(sql_config())
        status = 200
        error_message = ""
        try:
            if path == "/api/health":
                self.json_response(health(conn, client, probe_sql=first(query, "probe", "") == "sql"))
            elif path == "/api/runtime/logs":
                self.json_response({"ok": True, "started_at": STARTED_AT, "logs": list(RUNTIME_LOG)[-120:]})
            elif path == "/api/sync":
                limit = int(first(query, "limit", "5000"))
                mode = first(query, "mode", "incremental")
                self.json_response(sync_trace(conn, client, limit, mode))
            elif path == "/api/trace/summary":
                self.json_response(trace_summary(conn, client))
            elif path == "/api/trace/events":
                params = {key: first(query, key, "") for key in ("name", "type", "q", "limit", "offset", "start", "end", "sr_no", "sub_seq_no", "step", "source")}
                self.json_response(trace_events(conn, client, params))
            elif path == "/api/runs":
                params = {key: first(query, key, "") for key in ("name", "type", "limit", "start", "end", "status")}
                self.json_response(runs(conn, params))
            elif path.startswith("/api/runs/"):
                run_id = unquote(path.split("/api/runs/", 1)[1])
                self.json_response(run_detail(conn, run_id))
            elif path == "/api/workflows":
                self.json_response(workflows(conn, client))
            elif path.startswith("/api/workflows/"):
                name = unquote(path.split("/api/workflows/", 1)[1])
                self.json_response(workflow_detail(conn, client, name))
            elif path == "/api/analytics":
                self.json_response(analytics(conn, client))
            elif path == "/api/playback":
                params = {key: first(query, key, "") for key in ("name", "type", "q", "limit", "start", "end", "sr_no", "sub_seq_no", "step", "run_id")}
                self.json_response(playback(conn, params))
            elif path == "/api/atlas":
                params = {key: first(query, key, "") for key in ("name", "type", "status", "start", "end", "sort", "limit")}
                self.json_response(atlas.atlas_payload(conn, params))
            elif path.startswith("/api/atlas/runs/"):
                run_id = unquote(path.split("/api/atlas/runs/", 1)[1])
                payload = atlas.run_payload(conn, run_id)
                if payload is None:
                    status = 404
                    self.json_response({"ok": False, "error": f"Run not found: {run_id}"}, status=404)
                else:
                    self.json_response(payload)
            else:
                status = 404
                self.send_error(404)
        except SqlClientError as exc:
            status = 503
            error_message = sanitize_runtime_error(f"{type(exc).__name__}: {exc}", client)
            self.json_response(
                {
                    "ok": False,
                    "error": str(exc),
                    "source": "sql",
                    "cache_watermark": cache.get_watermark(conn),
                },
                status=503,
            )
        except Exception as exc:
            status = 500
            error_message = sanitize_runtime_error(f"{type(exc).__name__}: {exc}", client)
            self.json_response({"ok": False, "error": error_message}, status=500)
        finally:
            log_runtime(method, path, query, started, status, error_message)
            conn.close()

    def json_response(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def first(query: dict[str, list[str]], key: str, default: str) -> str:
    value = query.get(key, [default])[0]
    return value if value is not None else default


def health(conn, client: SqlClient, probe_sql: bool = False) -> dict:
    sql_ok = False
    sql_error = None
    columns = []
    if probe_sql:
        try:
            columns = client.trace_columns()
            sql_ok = True
        except Exception as exc:
            sql_error = str(exc)
    cached = cache.cached_summary(conn)
    return {
        "ok": True,
        "started_at": STARTED_AT,
        "cache_rows": cached.get("cache_rows", 0),
        "cache_watermark": cached.get("watermark"),
        "sql_configured": client.config.configured,
        "sql_ok": sql_ok,
        "sql_error": sql_error,
        "sql_probe": probe_sql,
        "database": client.config.database,
        "db_path": str(DB_PATH),
        "sp_doc_exists": SP_DOC_PATH.exists(),
        "schema_doc_exists": SCHEMA_DOC_PATH.exists(),
        "columns": columns,
    }


def sync_trace(conn, client: SqlClient, limit: int, mode: str = "incremental") -> dict:
    safe_limit = max(1, min(int(limit or 5000), 5000))
    watermark = None if mode == "recent" else cache.get_watermark(conn)
    rows = client.events_after(watermark, limit=safe_limit)
    inserted = cache.upsert_trace_events(conn, rows)

    warnings: list[str] = []
    procedures_updated = 0
    if SP_DOC_PATH.exists():
        try:
            names = sorted({row.get("name") for row in rows if row.get("name") and row.get("name") != "<anonymous>"})
            if names:
                infos = parsers.parse_procedures(SP_DOC_PATH, names[:100])
                cache.upsert_procedures(conn, infos)
                procedures_updated = len(infos)
        except Exception as exc:
            warnings.append(f"Stored-procedure metadata refresh skipped: {type(exc).__name__}: {exc}")
    else:
        warnings.append(f"Stored-procedure metadata refresh skipped: missing {SP_DOC_PATH.name}")

    result = analyzer.analyze(conn)
    analyzer.reconstruct_and_save_runs(conn)
    return {
        "ok": True,
        "mode": mode,
        "limit": safe_limit,
        "inserted": inserted,
        "procedures_updated": procedures_updated,
        "warnings": warnings,
        "watermark": cache.get_watermark(conn),
        "analysis": result["metrics"],
    }


def trace_summary(conn, client: SqlClient) -> dict:
    # Page load must be cache-first. Full SQL scans over the trace view are explicit actions.
    live = {"ok": False, "mode": "deferred", "message": "Use sync or source=sql filters for live SQL reads."}
    return {"ok": True, "live": live, "cache": cache.cached_summary(conn)}


def trace_events(conn, client: SqlClient, params: dict) -> dict:
    if params.get("source") == "sql":
        events = client.filtered_events(params)
        source = "sql-live"
    else:
        events = cache.cached_events(conn, params)
        source = "cache"
    return {"ok": True, "source": source, "events": events}


def workflows(conn, client: SqlClient) -> dict:
    if not cache.list_procedures(conn):
        names = [row["name"] for row in client.top_names(100) if row["name"] != "<anonymous>"]
        cache.upsert_procedures(conn, parsers.parse_procedures(SP_DOC_PATH, names))
    return {"ok": True, "graph": analyzer.graph_payload(conn), "procedures": cache.list_procedures(conn)}


def workflow_detail(conn, client: SqlClient, name: str) -> dict:
    proc = cache.get_procedure(conn, name)
    if not proc and name != "<anonymous>":
        info = parsers.parse_procedure(SP_DOC_PATH, name)
        cache.upsert_procedures(conn, [info])
        proc = cache.get_procedure(conn, name)
    events = cache.cached_events(conn, {"name": name, "limit": 100, "offset": 0})
    return {"ok": True, "procedure": proc, "events": events}


def analytics(conn, client: SqlClient) -> dict:
    return {"ok": True, **analyzer.analyze(conn, None)}


def playback(conn, params: dict) -> dict:
    return {"ok": True, **analyzer.playback_payload(conn, params)}


def runs(conn, params: dict) -> dict:
    return {"ok": True, "source": "cache", "runs": analyzer.get_runs(conn, params)}


def run_detail(conn, run_id: str) -> dict:
    run = analyzer.get_run_detail(conn, run_id)
    if not run:
        return {"ok": False, "error": f"Run not found: {run_id}"}
    return {"ok": True, "source": "cache", "run": run}


def log_runtime(method: str, path: str, query: dict[str, list[str]], started: float, status: int, error: str = "") -> None:
    elapsed_ms = round((time.perf_counter() - started) * 1000, 1)
    RUNTIME_LOG.append(
        {
            "ts": time.strftime("%H:%M:%S"),
            "method": method,
            "path": path,
            "status": status,
            "elapsed_ms": elapsed_ms,
            "query": {key: values[0] if values else "" for key, values in query.items()},
            "error": error,
        }
    )


def sanitize_runtime_error(message: str, client: SqlClient) -> str:
    if client.config.password:
        return message.replace(client.config.password, "<redacted>")
    return message


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the local Tracer analysis server.")
    parser.add_argument("--host", default="127.0.0.1", help="Bind host (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=PORT, help=f"Bind port (default: {PORT})")
    args = parser.parse_args()
    mimetypes.add_type("text/javascript", ".js")
    init_conn = cache.connect()
    try:
        cache.init_db(init_conn)
    finally:
        init_conn.close()
    httpd = ThreadingHTTPServer((args.host, args.port), TracerServer)
    print(f"Tracer running at http://{args.host}:{args.port}")
    httpd.serve_forever()


if __name__ == "__main__":
    main()
