from __future__ import annotations

import hashlib
import math
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from statistics import median
from typing import Any, Iterable


Record = dict[str, Any]
MAX_RUNS = 5000
MAX_MATRIX_RUNS = 300
MAX_STEPS = 80


def atlas_payload(conn, filters: Record | None = None) -> Record:
    """Build the coordinated execution-atlas view from reconstructed runs."""
    filters = filters or {}
    runs = _load_runs(conn, filters)
    events_by_run = _load_events(conn, [run["run_id"] for run in runs])
    cohorts = _build_cohorts(runs, events_by_run)
    analyses = [
        _analyse_run(run, events_by_run.get(run["run_id"], []), cohorts[(run["name"], run["type"])])
        for run in runs
    ]

    sort_name = str(filters.get("sort") or "deviation")
    analyses.sort(key=_sort_key(sort_name), reverse=sort_name != "oldest")
    matrix_limit = _bounded_int(filters.get("limit"), 160, 20, MAX_MATRIX_RUNS)
    matrix_runs = analyses[:matrix_limit]
    steps = _matrix_steps(matrix_runs, cohorts)

    watermark = conn.execute("SELECT MAX(entry_datetime) AS value FROM trace_events").fetchone()["value"]
    return {
        "ok": True,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "freshness": _freshness(watermark),
        "filters": _filter_options(conn),
        "summary": _summary(analyses),
        "density": _density(analyses),
        "steps": steps,
        "runs": [_matrix_run(item, steps) for item in matrix_runs],
        "anomalies": [_inbox_item(item) for item in analyses if item["deviation_score"] > 0][:80],
        "variants": _variants(analyses),
        "latency": _latency_summary(analyses, steps),
        "result": {
            "total_matching": len(analyses),
            "shown": len(matrix_runs),
            "truncated": len(analyses) > len(matrix_runs),
            "sort": sort_name,
            "matrix_mode": "normalized" if steps and steps[0]["key"].startswith("ordinal:") else "semantic",
        },
    }


def run_payload(conn, run_id: str) -> Record | None:
    rows = _load_runs(conn, {"run_id": run_id})
    if not rows:
        return None
    run = rows[0]
    cohort_runs = _load_runs(conn, {"name": run["name"], "type": run["type"]})
    events_by_run = _load_events(conn, [row["run_id"] for row in cohort_runs])
    cohort = _build_cohorts(cohort_runs, events_by_run)[(run["name"], run["type"])]
    analysis = _analyse_run(run, events_by_run.get(run_id, []), cohort)
    return {"ok": True, "run": _run_detail(analysis, cohort)}


def _load_runs(conn, filters: Record) -> list[Record]:
    clauses: list[str] = []
    values: list[Any] = []
    for key, column in (("name", "name"), ("type", "type"), ("status", "status"), ("run_id", "run_id")):
        value = filters.get(key)
        if value:
            clauses.append(f"{column} = ?")
            values.append(value)
    if filters.get("start"):
        clauses.append("start_time >= ?")
        values.append(filters["start"])
    if filters.get("end"):
        end_value = str(filters["end"])
        if _is_date_only(end_value):
            clauses.append("start_time < ?")
            values.append((datetime.fromisoformat(end_value) + timedelta(days=1)).date().isoformat())
        else:
            clauses.append("start_time <= ?")
            values.append(end_value)
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    rows = conn.execute(
        f"""
        SELECT run_id, name, type, start_time, end_time, duration_ms, status,
               event_count, error_count, parameter_signature
        FROM actual_runs
        {where}
        ORDER BY start_time DESC
        LIMIT ?
        """,
        [*values, MAX_RUNS],
    ).fetchall()
    return [dict(row) for row in rows]


def _load_events(conn, run_ids: list[str]) -> dict[str, list[Record]]:
    if not run_ids:
        return {}
    result: defaultdict[str, list[Record]] = defaultdict(list)
    for start in range(0, len(run_ids), 600):
        batch = run_ids[start : start + 600]
        placeholders = ",".join("?" for _ in batch)
        rows = conn.execute(
            f"""
            SELECT re.run_id, e.id, e.entry_datetime, e.step, e.sr_no, e.sub_seq_no,
                   e.execution_query, e.details
            FROM actual_run_events re
            JOIN trace_events e ON e.id = re.event_id
            WHERE re.run_id IN ({placeholders})
            ORDER BY re.run_id, e.entry_datetime, e.sr_no, e.sub_seq_no, e.id
            """,
            batch,
        ).fetchall()
        for row in rows:
            result[row["run_id"]].append(dict(row))
    return dict(result)


def _build_cohorts(runs: list[Record], events_by_run: dict[str, list[Record]]) -> dict[tuple[str, str], Record]:
    grouped: defaultdict[tuple[str, str], list[Record]] = defaultdict(list)
    for run in runs:
        grouped[(run.get("name") or "<anonymous>", run.get("type") or "<null>")].append(run)

    cohorts: dict[tuple[str, str], Record] = {}
    for key, cohort_runs in grouped.items():
        variants: Counter[tuple[str, ...]] = Counter()
        labels: defaultdict[str, Counter[str]] = defaultdict(Counter)
        gaps: defaultdict[str, list[float]] = defaultdict(list)
        for run in cohort_runs:
            events = events_by_run.get(run["run_id"], [])
            sequence = tuple(_step_key(event) for event in events)
            variants[sequence] += 1
            previous_time = None
            for event in events:
                step_key = _step_key(event)
                labels[step_key][str(event.get("step") or "Unlabelled step")] += 1
                current_time = _parse_time(event.get("entry_datetime"))
                if previous_time and current_time:
                    gaps[step_key].append(max(0.0, (current_time - previous_time).total_seconds() * 1000))
                previous_time = current_time or previous_time

        expected = variants.most_common(1)[0][0] if variants else ()
        cohorts[key] = {
            "run_count": len(cohort_runs),
            "variants": variants,
            "expected": list(expected),
            "labels": {step: counts.most_common(1)[0][0] for step, counts in labels.items()},
            "gaps": {step: sorted(values) for step, values in gaps.items()},
        }
    return cohorts


def _analyse_run(run: Record, events: list[Record], cohort: Record) -> Record:
    expected = cohort["expected"]
    actual = [_step_key(event) for event in events]
    expected_set = set(expected)
    actual_set = set(actual)
    missing = [step for step in expected if step not in actual_set]
    unexpected = [step for step in actual if step not in expected_set]
    repetitions = [step for step, count in Counter(actual).items() if count > Counter(expected).get(step, 1)]
    shared_actual = [step for step in actual if step in expected_set]
    expected_positions = {step: index for index, step in enumerate(expected)}
    reordered = any(
        expected_positions[shared_actual[index]] < expected_positions[shared_actual[index - 1]]
        for index in range(1, len(shared_actual))
    )
    signature = tuple(actual)
    variant_count = cohort["variants"].get(signature, 0)
    variant_rate = variant_count / max(1, cohort["run_count"])

    timings: dict[str, float] = {}
    previous_time = None
    slow: list[Record] = []
    for event in events:
        key = _step_key(event)
        current_time = _parse_time(event.get("entry_datetime"))
        gap_ms = max(0.0, (current_time - previous_time).total_seconds() * 1000) if current_time and previous_time else 0.0
        timings[key] = max(timings.get(key, 0.0), gap_ms)
        baseline = cohort["gaps"].get(key, [])
        p95 = _percentile(baseline, 0.95)
        if len(baseline) >= 5 and gap_ms > max(10.0, p95) and gap_ms >= p95 * 1.15:
            slow.append({"step": key, "actual_ms": round(gap_ms, 1), "p95_ms": round(p95, 1)})
        previous_time = current_time or previous_time

    status = str(run.get("status") or "unknown")
    score = 0
    if status == "error":
        score += 45
    elif status in {"incomplete", "orphan"}:
        score += 30
    elif status == "unknown":
        score += 10
    score += min(28, len(missing) * 7)
    score += min(18, len(unexpected) * 4)
    score += min(16, len(slow) * 4)
    score += min(10, len(repetitions) * 3)
    if reordered:
        score += 12
    if cohort["run_count"] >= 10 and variant_rate < 0.02:
        score += 8
    score = min(100, score)

    cells: dict[str, Record] = {}
    for step in expected:
        cells[step] = {"state": "missing" if step in missing else "normal", "duration_ms": round(timings.get(step, 0.0), 1)}
    for item in slow:
        cells.setdefault(item["step"], {})["state"] = "slow"
        cells[item["step"]].update(item)
    for step in repetitions:
        cells.setdefault(step, {})["state"] = "repeated"
    for step in unexpected:
        cells[step] = {"state": "unexpected", "duration_ms": round(timings.get(step, 0.0), 1)}

    result = dict(run)
    result.update(
        {
            "events": events,
            "actual": actual,
            "expected": expected,
            "missing": missing,
            "unexpected": unexpected,
            "slow": slow,
            "repeated": repetitions,
            "reordered": reordered,
            "variant_count": variant_count,
            "variant_rate": variant_rate,
            "deviation_score": score,
            "cells": cells,
            "explanations": _explanations(status, missing, unexpected, slow, repetitions, reordered, variant_rate, cohort),
        }
    )
    return result


def _explanations(status: str, missing: list[str], unexpected: list[str], slow: list[Record], repeated: list[str], reordered: bool, variant_rate: float, cohort: Record) -> list[Record]:
    labels = cohort["labels"]
    items: list[Record] = []
    if status == "error":
        items.append({"kind": "error", "severity": "high", "text": "The run reached an error or failure event."})
    elif status in {"incomplete", "orphan"}:
        items.append({"kind": status, "severity": "high", "text": f"The run is {status}; its start/end boundary is incomplete."})
    for step in missing[:4]:
        items.append({"kind": "missing", "severity": "high", "step": step, "text": f"Missing expected step: {labels.get(step, step)}."})
    for step in unexpected[:4]:
        items.append({"kind": "unexpected", "severity": "medium", "step": step, "text": f"Unexpected step: {labels.get(step, step)}."})
    for item in slow[:4]:
        items.append({"kind": "slow", "severity": "medium", "step": item["step"], "text": f"{labels.get(item['step'], item['step'])} took {item['actual_ms']:,.1f} ms; cohort p95 is {item['p95_ms']:,.1f} ms."})
    if reordered:
        items.append({"kind": "reordered", "severity": "medium", "text": "Expected steps appeared out of their dominant sequence."})
    if repeated:
        items.append({"kind": "repeated", "severity": "low", "text": f"Repeated steps detected: {len(repeated)}."})
    if cohort["run_count"] >= 10 and variant_rate < 0.02:
        items.append({"kind": "rare", "severity": "low", "text": f"This sequence represents {variant_rate:.1%} of comparable runs."})
    return items


def _matrix_steps(analyses: list[Record], cohorts: dict[tuple[str, str], Record]) -> list[Record]:
    cohort_keys = {(item.get("name"), item.get("type")) for item in analyses}
    if len(cohort_keys) > 1:
        longest = min(MAX_STEPS, max((len(item["expected"]) for item in analyses), default=0))
        return [{"key": f"ordinal:{index}", "label": f"Step {index + 1}", "count": sum(len(item["expected"]) > index for item in analyses)} for index in range(longest)]

    counts: Counter[str] = Counter()
    labels: defaultdict[str, Counter[str]] = defaultdict(Counter)
    for item in analyses:
        cohort = cohorts[(item["name"], item["type"])]
        for step in item["expected"]:
            counts[step] += 2
            labels[step][cohort["labels"].get(step, step)] += 1
        for step in item["actual"]:
            counts[step] += 1
            labels[step][cohort["labels"].get(step, step)] += 1
    ordered = sorted(counts, key=lambda step: (-counts[step], _step_sort_key(step)))[:MAX_STEPS]
    ordered.sort(key=_step_sort_key)
    return [
        {"key": step, "label": labels[step].most_common(1)[0][0] if labels[step] else step, "count": counts[step]}
        for step in ordered
    ]


def _matrix_run(item: Record, steps: list[Record]) -> Record:
    cells = []
    for step in steps:
        if step["key"].startswith("ordinal:"):
            ordinal = int(step["key"].split(":", 1)[1])
            source_key = item["expected"][ordinal] if ordinal < len(item["expected"]) else None
            cells.append(item["cells"].get(source_key, {"state": "not-applicable"}) if source_key else {"state": "not-applicable"})
        else:
            cells.append(item["cells"].get(step["key"], {"state": "not-applicable"}))
    return {
        "run_id": item["run_id"],
        "name": item["name"],
        "type": item["type"],
        "start_time": item["start_time"],
        "duration_ms": item["duration_ms"],
        "status": item["status"],
        "event_count": item["event_count"],
        "deviation_score": item["deviation_score"],
        "primary_reason": item["explanations"][0]["text"] if item["explanations"] else "Matches the dominant cohort pattern.",
        "cells": cells,
    }


def _run_detail(item: Record, cohort: Record) -> Record:
    labels = cohort["labels"]
    event_by_step: defaultdict[str, list[Record]] = defaultdict(list)
    for event in item["events"]:
        event_by_step[_step_key(event)].append(event)
    waterfall = []
    for ordinal, step in enumerate(item["expected"], start=1):
        events = event_by_step.get(step, [])
        waterfall.append(
            {
                "ordinal": ordinal,
                "step": step,
                "label": labels.get(step, step),
                "state": item["cells"].get(step, {}).get("state", "normal") if events else "missing",
                "actual_ms": item["cells"].get(step, {}).get("duration_ms"),
                "p50_ms": round(_percentile(cohort["gaps"].get(step, []), 0.5), 1),
                "p95_ms": round(_percentile(cohort["gaps"].get(step, []), 0.95), 1),
            }
        )
    for step in item["unexpected"]:
        waterfall.append({"ordinal": None, "step": step, "label": labels.get(step, step), "state": "unexpected", "actual_ms": item["cells"].get(step, {}).get("duration_ms")})
    return {
        **{key: item.get(key) for key in ("run_id", "name", "type", "start_time", "end_time", "duration_ms", "status", "event_count", "error_count", "deviation_score")},
        "cohort_runs": cohort["run_count"],
        "variant_rate": round(item["variant_rate"], 6),
        "explanations": item["explanations"],
        "waterfall": waterfall,
        "events": item["events"],
    }


def _inbox_item(item: Record) -> Record:
    return {
        "run_id": item["run_id"],
        "name": item["name"],
        "type": item["type"],
        "start_time": item["start_time"],
        "status": item["status"],
        "deviation_score": item["deviation_score"],
        "reason": item["explanations"][0]["text"] if item["explanations"] else "Deviation detected.",
        "severity": "high" if item["deviation_score"] >= 40 else "medium" if item["deviation_score"] >= 18 else "low",
    }


def _summary(items: list[Record]) -> Record:
    total = len(items)
    deviated = sum(item["deviation_score"] > 0 for item in items)
    failed = sum(item["status"] == "error" for item in items)
    slow = sum(bool(item["slow"]) for item in items)
    durations = sorted(float(item.get("duration_ms") or 0) for item in items)
    return {
        "executions": total,
        "deviated": deviated,
        "deviation_rate": round(deviated / max(1, total), 4),
        "failed": failed,
        "failure_rate": round(failed / max(1, total), 4),
        "slow": slow,
        "slow_rate": round(slow / max(1, total), 4),
        "p95_duration_ms": round(_percentile(durations, 0.95), 1),
    }


def _density(items: list[Record], bucket_count: int = 36) -> list[Record]:
    dated = [(item, _parse_time(item.get("start_time"))) for item in items]
    dated = [(item, date) for item, date in dated if date]
    if not dated:
        return []
    start = min(date for _, date in dated)
    end = max(date for _, date in dated)
    span = max(1.0, (end - start).total_seconds())
    buckets = [{"start": datetime.fromtimestamp(start.timestamp() + span * index / bucket_count, tz=start.tzinfo).isoformat(), "total": 0, "deviated": 0, "failed": 0} for index in range(bucket_count)]
    for item, date in dated:
        index = min(bucket_count - 1, int(((date - start).total_seconds() / span) * bucket_count))
        buckets[index]["total"] += 1
        buckets[index]["deviated"] += int(item["deviation_score"] > 0)
        buckets[index]["failed"] += int(item["status"] == "error")
    return buckets


def _variants(items: list[Record]) -> list[Record]:
    counts: Counter[tuple[str, ...]] = Counter(tuple(item["actual"]) for item in items)
    total = max(1, len(items))
    output = []
    for sequence, count in counts.most_common(12):
        matching = [item for item in items if tuple(item["actual"]) == sequence]
        avg_score = sum(item["deviation_score"] for item in matching) / max(1, len(matching))
        output.append(
            {
                "id": hashlib.sha1("|".join(sequence).encode("utf-8")).hexdigest()[:10],
                "count": count,
                "rate": round(count / total, 4),
                "step_count": len(sequence),
                "average_deviation": round(avg_score, 1),
                "pattern": [_state_symbol(item, step) for step in sequence[:24] for item in matching[:1]],
            }
        )
    return output


def _state_symbol(item: Record, step: str) -> str:
    return item["cells"].get(step, {}).get("state", "normal")


def _latency_summary(items: list[Record], steps: list[Record]) -> list[Record]:
    result = []
    for step in steps:
        if step["key"].startswith("ordinal:"):
            ordinal = int(step["key"].split(":", 1)[1])
            source_keys = [item["expected"][ordinal] if ordinal < len(item["expected"]) else None for item in items]
        else:
            source_keys = [step["key"] for _ in items]
        values = sorted(
            float(item["cells"].get(source_key, {}).get("duration_ms") or 0)
            for item, source_key in zip(items, source_keys)
            if source_key and source_key in item["cells"]
        )
        if not values:
            continue
        slow_count = sum(
            bool(source_key) and item["cells"].get(source_key, {}).get("state") == "slow"
            for item, source_key in zip(items, source_keys)
        )
        result.append(
            {
                "step": step["key"],
                "label": step["label"],
                "p50_ms": round(_percentile(values, 0.5), 1),
                "p95_ms": round(_percentile(values, 0.95), 1),
                "p99_ms": round(_percentile(values, 0.99), 1),
                "max_ms": round(max(values), 1),
                "slow_rate": round(slow_count / max(1, len(items)), 4),
            }
        )
    return result[:24]


def _filter_options(conn) -> Record:
    names = [dict(row) for row in conn.execute("SELECT name, COUNT(*) AS count FROM actual_runs WHERE name IS NOT NULL GROUP BY name ORDER BY count DESC, name")]
    types = [dict(row) for row in conn.execute("SELECT type, COUNT(*) AS count FROM actual_runs WHERE type IS NOT NULL GROUP BY type ORDER BY count DESC, type")]
    cohorts = [
        dict(row)
        for row in conn.execute(
            """SELECT name, type, COUNT(*) AS count
               FROM actual_runs
               WHERE name IS NOT NULL AND type IS NOT NULL
               GROUP BY name, type
               ORDER BY count DESC, name, type"""
        )
    ]
    bounds = dict(conn.execute("SELECT MIN(start_time) AS start, MAX(start_time) AS end FROM actual_runs").fetchone())
    return {
        "names": names,
        "types": types,
        "cohorts": cohorts,
        "statuses": ["complete", "error", "incomplete", "orphan", "unknown"],
        "bounds": bounds,
    }


def _freshness(watermark: str | None) -> Record:
    parsed = _parse_time(watermark)
    if not parsed:
        return {"watermark": watermark, "state": "empty", "age_seconds": None}
    now = datetime.now(parsed.tzinfo or timezone.utc)
    age = max(0, int((now - parsed).total_seconds()))
    state = "fresh" if age < 300 else "stale" if age < 86400 else "offline"
    return {"watermark": watermark, "state": state, "age_seconds": age}


def _sort_key(name: str):
    if name == "duration":
        return lambda item: (item.get("duration_ms") or 0, item.get("start_time") or "")
    if name == "newest":
        return lambda item: item.get("start_time") or ""
    if name == "oldest":
        return lambda item: item.get("start_time") or ""
    return lambda item: (item["deviation_score"], item.get("start_time") or "")


def _step_key(event: Record) -> str:
    sr = event.get("sr_no")
    sub = event.get("sub_seq_no")
    if sr is not None or sub is not None:
        return f"{sr if sr is not None else 'x'}:{sub if sub is not None else 'x'}"
    text = " ".join(str(event.get("step") or "unknown").lower().split())
    return f"text:{hashlib.sha1(text.encode('utf-8')).hexdigest()[:8]}"


def _step_sort_key(value: str) -> tuple[int, int, str]:
    if ":" in value and not value.startswith("text:"):
        left, right = value.split(":", 1)
        try:
            return int(left), int(right), value
        except ValueError:
            pass
    return (10**9, 10**9, value)


def _parse_time(value: Any) -> datetime | None:
    if not value:
        return None
    text = str(value).strip().replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(text)
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _is_date_only(value: str) -> bool:
    if len(value) != 10:
        return False
    try:
        datetime.strptime(value, "%Y-%m-%d")
        return True
    except ValueError:
        return False


def _percentile(values: Iterable[float], quantile: float) -> float:
    data = sorted(float(value) for value in values)
    if not data:
        return 0.0
    if len(data) == 1:
        return data[0]
    position = (len(data) - 1) * quantile
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return data[lower]
    return data[lower] + (data[upper] - data[lower]) * (position - lower)


def _bounded_int(value: Any, default: int, minimum: int, maximum: int) -> int:
    try:
        return max(minimum, min(maximum, int(value)))
    except (TypeError, ValueError):
        return default
