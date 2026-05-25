from __future__ import annotations

from collections import defaultdict
from typing import Any

Record = dict[str, Any]

LANE_BY_KIND = {
    "procedure": "PROCEDURE",
    "workflow": "WORKFLOW",
    "step": "INTERNAL STEP",
    "error": "API ERROR",
    "anonymous": "UNKNOWN",
    "unknown": "UNKNOWN",
    "table": "TABLE",
    "table_read": "TABLE",
    "table_update": "TABLE",
    "table_write": "TABLE",
}

ROLE_BY_KIND = {
    "procedure": "service",
    "workflow": "orchestrator",
    "step": "operation",
    "error": "damage",
    "anonymous": "unmapped",
    "unknown": "unmapped",
    "table": "entity",
    "table_read": "entity-read",
    "table_update": "entity-update",
    "table_write": "entity-write",
}


def annotate_graph_placement(node_map: dict[str, Record], edges: list[Record], dominant_id: str | None) -> None:
    """Attach syntax-driven semantic placement metadata to graph nodes and edges."""
    degrees: defaultdict[str, int] = defaultdict(int)
    outgoing: defaultdict[str, list[Record]] = defaultdict(list)
    incoming: defaultdict[str, list[Record]] = defaultdict(list)
    for edge in edges:
        source = str(edge.get("source") or "")
        target = str(edge.get("target") or "")
        degrees[source] += 1
        degrees[target] += 1
        outgoing[source].append(edge)
        incoming[target].append(edge)

    ranked_nodes = sorted(
        node_map.values(),
        key=lambda node: (
            -(node.get("trace_count") or 0),
            -degrees.get(str(node.get("id") or ""), 0),
            str(node.get("id") or ""),
        ),
    )
    rank_by_id = {str(node.get("id") or ""): idx + 1 for idx, node in enumerate(ranked_nodes)}

    for node in node_map.values():
        node_id = str(node.get("id") or "")
        kind = str(node.get("kind") or "unknown")
        lane = LANE_BY_KIND.get(kind, "UNKNOWN")
        role = ROLE_BY_KIND.get(kind, "unmapped")
        relation = _relation_for_node(node, dominant_id, incoming.get(node_id, []), outgoing.get(node_id, []))
        band = _band_for_node(node, relation)
        rank = rank_by_id.get(node_id, len(ranked_nodes) + 1)
        sequence = _sequence_for_node(node, rank)
        weight = _weight_for_node(node, degrees.get(node_id, 0))

        syntax = (
            f"kind:{kind} lane:{lane} role:{role} relation:{relation} "
            f"band:{band} rank:{rank} seq:{sequence} weight:{weight}"
        )
        node["placement_syntax"] = syntax
        node["placement"] = parse_placement_syntax(syntax)

    for edge in edges:
        kind = str(edge.get("kind") or "unknown")
        relation = _edge_relation(kind)
        strength = "strong" if kind in {"calls", "writes", "updates", "error"} else "weak" if kind == "static_step" else "normal"
        syntax = f"edge:{kind} relation:{relation} strength:{strength} weight:{edge.get('weight') or 1}"
        edge["placement_syntax"] = syntax
        edge["placement"] = parse_placement_syntax(syntax)


def parse_placement_syntax(syntax: str) -> Record:
    """Parse key:value placement syntax into typed metadata."""
    parsed: Record = {}
    for token in str(syntax or "").split():
        if ":" not in token:
            continue
        key, value = token.split(":", 1)
        parsed[key] = _typed_value(value)
    return parsed


def _relation_for_node(node: Record, dominant_id: str | None, incoming: list[Record], outgoing: list[Record]) -> str:
    node_id = str(node.get("id") or "")
    kind = str(node.get("kind") or "unknown")
    if node_id and node_id == dominant_id:
        return "focus"
    if kind == "step":
        return "child-step"
    if kind.startswith("table"):
        if any(edge.get("kind") in {"writes", "updates"} for edge in incoming + outgoing):
            return "mutated-entity"
        return "read-entity"
    if kind in {"error", "anonymous", "unknown"} or node.get("is_damage"):
        return "damage"
    if any(edge.get("kind") == "calls" for edge in incoming):
        return "called-by-context"
    if any(edge.get("kind") == "calls" for edge in outgoing):
        return "calls-out"
    return "context"


def _band_for_node(node: Record, relation: str) -> str:
    if relation == "focus":
        return "center"
    if relation in {"damage", "called-by-context", "calls-out"}:
        return "upper"
    if relation in {"mutated-entity", "read-entity"}:
        return "lower"
    if relation == "child-step":
        return "rail"
    if (node.get("trace_count") or 0) > 0:
        return "active"
    return "passive"


def _sequence_for_node(node: Record, fallback: int) -> int:
    for key in ("ordinal", "sub_seq_no", "sr_no"):
        value = node.get(key)
        if value not in (None, ""):
            try:
                return int(value)
            except (TypeError, ValueError):
                continue
    return fallback


def _weight_for_node(node: Record, degree: int) -> int:
    trace_count = int(node.get("trace_count") or 0)
    importance = float(node.get("importance") or 0)
    return max(1, min(100, trace_count + degree * 4 + round(importance * 30)))


def _edge_relation(kind: str) -> str:
    if kind == "calls":
        return "control-flow"
    if kind in {"writes", "updates"}:
        return "mutation"
    if kind == "reads":
        return "dependency"
    if kind == "static_step":
        return "decomposition"
    if kind == "error":
        return "damage"
    return "association"


def _typed_value(value: str) -> Any:
    if value.lstrip("-").isdigit():
        return int(value)
    try:
        return float(value)
    except ValueError:
        return value
