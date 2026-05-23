from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Iterable


NOISE_NAMES = {
    "template",
    "sp_executesql",
    "nvarchar",
    "varchar",
    "dbo",
    "cur",
    "xstudio_configuration",
    "xstudio_add_errorlog_usp",
}


@dataclass
class ProcedureInfo:
    name: str
    found: bool
    log_ref_count: int
    calls: list[str]
    reads: list[str]
    inserts: list[str]
    updates: list[str]
    steps: list[dict]
    excerpt: str
    expected_path: list[dict] = field(default_factory=list)
    parameters: list[dict] = field(default_factory=list)
    error_handlers: list[dict] = field(default_factory=list)
    table_touches_by_step: dict[str, list[str]] = field(default_factory=dict)
    calls_by_step: dict[str, list[str]] = field(default_factory=dict)
    confidence: float = 0.0

    def to_json(self) -> dict:
        return asdict(self)


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="ignore")


def procedure_blocks(sp_doc_path: Path) -> dict[str, str]:
    text = _read(sp_doc_path)
    blocks: dict[str, str] = {}
    for match in re.finditer(r"^##\s+dbo\.([^\r\n]+)(.*?)(?=^##\s+dbo\.|\Z)", text, flags=re.M | re.S):
        blocks[match.group(1).strip().lower()] = match.group(2)
    return blocks


def _clean_names(values: Iterable[str], current_name: str) -> list[str]:
    cleaned = []
    for value in values:
        item = value.strip("[] \r\n\t;,.")
        if not item:
            continue
        low = item.lower()
        if low in NOISE_NAMES or low == current_name.lower():
            continue
        if item not in cleaned:
            cleaned.append(item)
    return sorted(cleaned)


def _extract_steps(body: str) -> list[dict]:
    steps: list[dict] = []
    for idx, match in enumerate(re.finditer(r"XMES_Log_?trn_?Tbl", body, flags=re.I), start=1):
        start = max(0, match.start() - 700)
        end = min(len(body), match.end() + 1300)
        chunk = body[start:end]
        
        is_error = "CATCH" in chunk.upper()[:700] or "ERROR" in chunk.upper()[:700]
        strings = [s.strip() for s in re.findall(r"'([^']{3,220})'", chunk)]
        step_candidates = [
            s
            for s in strings
            if re.search(r"\b(entered|completed|process|update|insert|store|cursor|set|error|start|end)\b", s, re.I)
        ]
        sr = re.search(r"@?SrNo\]?\s*[,=]\s*(\d+)", chunk, flags=re.I)
        sub = re.search(r"@?SubSeqNo\]?\s*[,=]\s*(\d+)", chunk, flags=re.I)
        step_text = step_candidates[-1] if step_candidates else f"Log point {idx}"
        
        kind = "step"
        if re.search(r"\b(entered|start)\b", step_text, re.I): kind = "start"
        elif re.search(r"\b(completed|end)\b", step_text, re.I): kind = "end"
        elif is_error or re.search(r"\b(error|fail)\b", step_text, re.I): kind = "error"

        record = {
            "ordinal": idx,
            "sr_no": int(sr.group(1)) if sr else None,
            "sub_seq_no": int(sub.group(1)) if sub else None,
            "step": step_text,
            "kind": kind,
            "source_excerpt": chunk[:400]
        }
        if record not in steps:
            steps.append(record)
    return steps


def parse_procedure(sp_doc_path: Path, name: str) -> ProcedureInfo:
    blocks = procedure_blocks(sp_doc_path)
    body = blocks.get(name.lower(), "")
    if not body:
        return ProcedureInfo(name, False, 0, [], [], [], [], [], "")

    parameters = []
    param_match = re.search(r"CREATE\s+PROC(?:EDURE)?\s+(?:\[.*?\]\.)?\[?[a-zA-Z0-9_-]+\]?\s*\((.*?)\)\s+AS", body, flags=re.I | re.S)
    if param_match:
        for p in re.findall(r"(@[a-zA-Z0-9_]+)\s+([a-zA-Z0-9_]+)(?:\([^)]+\))?(?:\s*=\s*([^,]+))?", param_match.group(1)):
            parameters.append({"name": p[0], "type": p[1], "default": p[2] if p[2] else None})

    calls = _clean_names(
        re.findall(r"\bEXEC(?:UTE)?\s+(?:\[[^\]]+\]\.)?(?:\[dbo\]\.)?\[?([A-Za-z0-9_\-]+)\]?", body, flags=re.I),
        name,
    )
    reads = _clean_names(
        re.findall(r"\bFROM\s+(?:\[[^\]]+\]\.)?(?:\[dbo\]\.)?\[?([A-Za-z0-9_]+)\]?", body, flags=re.I),
        name,
    )
    inserts = _clean_names(
        re.findall(r"\bINSERT\s+INTO\s+(?:\[[^\]]+\]\.)?(?:\[dbo\]\.)?\[?([A-Za-z0-9_]+)\]?", body, flags=re.I),
        name,
    )
    updates = _clean_names(
        re.findall(r"\bUPDATE\s+(?:\[[^\]]+\]\.)?(?:\[dbo\]\.)?\[?([A-Za-z0-9_]+)\]?", body, flags=re.I),
        name,
    )
    log_ref_count = len(re.findall(r"XMES_Log_?trn_?Tbl", body, flags=re.I))
    steps = _extract_steps(body)
    
    table_touches_by_step = {}
    calls_by_step = {}
    for step in steps:
        step_key = f"{step.get('sr_no')}_{step.get('sub_seq_no')}"
        chunk = step.get("source_excerpt", "")
        chunk_calls = _clean_names(re.findall(r"\bEXEC(?:UTE)?\s+(?:\[[^\]]+\]\.)?(?:\[dbo\]\.)?\[?([A-Za-z0-9_\-]+)\]?", chunk, flags=re.I), name)
        chunk_tables = _clean_names(re.findall(r"\b(?:FROM|INTO|UPDATE)\s+(?:\[[^\]]+\]\.)?(?:\[dbo\]\.)?\[?([A-Za-z0-9_]+)\]?", chunk, flags=re.I), name)
        calls_by_step[step_key] = chunk_calls
        table_touches_by_step[step_key] = chunk_tables

    return ProcedureInfo(
        name=name,
        found=True,
        log_ref_count=log_ref_count,
        calls=calls[:40],
        reads=reads[:80],
        inserts=inserts[:80],
        updates=updates[:80],
        steps=steps,
        excerpt=body[:6000],
        expected_path=steps,
        parameters=parameters,
        error_handlers=[],
        table_touches_by_step=table_touches_by_step,
        calls_by_step=calls_by_step,
        confidence=1.0 if steps else 0.5
    )


def parse_procedures(sp_doc_path: Path, names: Iterable[str]) -> list[ProcedureInfo]:
    return [parse_procedure(sp_doc_path, name) for name in names if name and name != "<anonymous>"]


def parse_schema_row_counts(schema_doc_path: Path) -> dict[str, int]:
    text = _read(schema_doc_path)
    counts: dict[str, int] = {}
    for line in text.splitlines():
        match = re.match(r"\|\s*dbo\.([^|]+?)\s*\|\s*[\d,]+\s*\|\s*([\d,]+)\s*\|", line)
        if match:
            counts[match.group(1).strip()] = int(match.group(2).replace(",", ""))
    return counts


def procedure_json_blob(info: ProcedureInfo) -> str:
    return json.dumps(info.to_json(), ensure_ascii=False)
