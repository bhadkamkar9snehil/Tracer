# Tracer

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)

**Tracer** is an early-stage 3D visualiser for logs.

The goal of Tracer is to make log exploration more spatial and interactive. Instead of scanning log lines one by one, Tracer is intended to help engineers load structured events, view them across time, inspect relationships between events, and identify patterns, anomalies, or broken flows in a 3D interface.

## Status

Tracer is currently in its initial project setup phase. This README describes the intended direction of the project and will be updated as the implementation, setup instructions, and runtime commands are added.

## Why Tracer?

Traditional log viewers are usually linear: search, filter, scroll, repeat. That works for simple debugging, but it becomes harder when logs include many services, sessions, traces, retries, or overlapping event streams.

Tracer is intended to help with:

- spotting bursts, gaps, clusters, and outliers in event streams;
- comparing logs across runs, requests, sessions, or services;
- visualising temporal relationships between related events;
- inspecting complex traces without losing the wider context;
- turning raw logs into an explorable debugging surface.

## Intended workflow

A typical Tracer workflow will look like this:

1. Export or collect logs from an application, service, script, or system.
2. Convert the logs into a structured event format.
3. Load the structured events into Tracer.
4. Explore the log data in a 3D scene using time, source, severity, and relationships as visual dimensions.
5. Select individual events to inspect their raw payload and metadata.

## Planned capabilities

Tracer is expected to grow around the following capabilities:

- structured log import, starting with formats such as JSON, NDJSON, or CSV;
- a timeline-based 3D visualisation of events;
- filtering by timestamp, severity, source, component, request ID, or trace ID;
- visual encoding for severity, category, duration, and relationship type;
- event selection with raw log payload inspection;
- support for sample datasets and reproducible demo scenarios;
- exportable or shareable views for debugging notes and investigations.

## Placement syntax

The next graph-layout phase is syntax-driven. The backend annotates every graph
object with a compact placement string and a parsed `placement` object. The
frontend requires that metadata for object placement. Missing or malformed
placement metadata is treated as a graph contract error, not silently inferred
in the browser.

Example node placement:

```text
kind:procedure lane:PROCEDURE role:service relation:focus band:center rank:1 seq:1 weight:100
```

Current placement fields:

- `kind`: source object type, such as `procedure`, `step`, `table_write`, or `unknown`.
- `lane`: horizontal semantic lane, such as `PROCEDURE`, `INTERNAL STEP`, `TABLE`, or `UNKNOWN`.
- `role`: human meaning of the object in the graph, such as `service`, `operation`, or `entity-write`.
- `relation`: relationship to the current graph context, such as `focus`, `child-step`, `called-by-context`, or `mutated-entity`.
- `band`: vertical visual band, such as `center`, `upper`, `rail`, `lower`, `active`, or `passive`.
- `rank`, `seq`, `weight`: deterministic ordering and emphasis values used by the renderer.

## Example event shape

Tracer will work best with structured logs. A minimal event could look like this:

```json
{
  "timestamp": "2026-05-23T10:30:00Z",
  "level": "info",
  "source": "api-gateway",
  "message": "Request completed",
  "trace_id": "trace-123",
  "span_id": "span-456",
  "duration_ms": 42,
  "attributes": {
    "method": "GET",
    "path": "/health",
    "status_code": 200
  }
}
```

This schema is illustrative and may change as the project develops.

## Repository setup

Clone the repository:

```bash
git clone https://github.com/bhadkamkar9snehil/Tracer.git
cd Tracer
```

The application source code has not been documented in this README yet. Once the implementation is added, this section should include:

- required runtime versions;
- dependency installation steps;
- local development commands;
- build commands;
- test commands;
- sample input files and demo instructions.

## Development notes

When implementation begins, keep the README aligned with the actual project by documenting:

- the supported log formats;
- the expected event schema;
- how to run the app locally;
- how to load demo data;
- any renderer, UI, backend, or storage assumptions;
- known limitations and performance expectations.

## Roadmap

Initial project milestones:

- [ ] Define the MVP structured event schema.
- [ ] Add sample log datasets.
- [ ] Implement the first log importer.
- [ ] Build the initial 3D event scene.
- [ ] Add basic filtering and event inspection.
- [ ] Document local setup and development commands.
- [ ] Add screenshots or a demo GIF once the UI exists.

## Contributing

Contributions are welcome once the project structure is in place.

For future contributions:

1. Open an issue describing the bug, improvement, or feature proposal.
2. Keep pull requests focused and small enough to review.
3. Include sample logs or screenshots when changing visual behaviour.
4. Update documentation when changing setup, input formats, or user-facing behaviour.

## License

Tracer is licensed under the [Apache License 2.0](LICENSE).
