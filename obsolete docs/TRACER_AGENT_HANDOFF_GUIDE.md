# Tracer Agent Handoff and Execution Guide

## Purpose of this document

This document is a handoff for Codex, Claude, or another implementation agent working on the local **Tracer** project.

It explains:

1. What has already been built.
2. What the product is supposed to become.
3. What the current codebase contains.
4. What must not regress.
5. Where the detailed phase-by-phase work table lives.
6. How to execute the remaining work safely.
7. What should be implemented first.

The detailed phase/file/change table has already been saved in:

```text
WorkToBeDone.md
```

Use `WorkToBeDone.md` as the master backlog. Use this document as the product, architecture, and regression-control guide.

---

# 1. Project summary

## Project name

**Tracer**

## Current app goal

Build a local, simple-stack trace visualizer for the SQL view:

```sql
XStudio_Xbatch.dbo.XStudio_List_XMES_Log_Trn_Tbl_Vw
```

The app should help diagnose what happened inside MES / XStudio / XMES stored-procedure execution flows.

The system should compare:

1. **What should have happened**
   - Inferred from stored-procedure code.
   - Expected log points.
   - Expected SP calls.
   - Expected reads/writes/updates.
   - Expected error branches.

2. **What actually happened**
   - Inferred from SQL trace rows.
   - Actual events from the trace view/cache.
   - Actual `Name`, `Type`, `Step`, `SrNo`, `SubSeqNo`, `ExecutionQuery`, `Details`, timestamps.

3. **What usually happens**
   - Learned from historical trace patterns.
   - Transition frequencies.
   - Parameter shapes.
   - Timing baselines.
   - Completion patterns.

4. **Where the delta is**
   - Missing expected steps.
   - Unexpected actual steps.
   - Slow gaps.
   - Incomplete runs.
   - Error branches.
   - Parameter anomalies.
   - Broken instrumentation.
   - Unknown/anonymous traces.

---

# 2. Final product goal

The final product must answer this investigation sequence:

```text
1. What process/SP/run am I looking at?
2. What should have happened?
3. What actually happened?
4. Where is the delta?
5. What does history predict should happen next?
6. Which evidence proves this?
```

Everything in the UI, backend APIs, graph model, playback system, and report/export functions must support that sequence.

---

# 3. Current folder structure

Current visible project structure:

```text
TRACER/
  __pycache__/
    server.cpython-312.pyc

  data/
    tracer-ui-filter-selection-fixed.png
    tracer-ui-smoke.png
    tracer.sqlite

  tracer/
    __pycache__/
    __init__.py
    analyzer.py
    cache.py
    config.py
    parsers.py
    sql_client.py

  web/
    index.html
    styles.css
    app.js
    vendor/
      three.module.js

  Detailed Log View Data 10000 Rows.xlsx
  FrontEndDesignSkill.md
  HANDOFF.md
  Log View Sample Data.xlsx
  server.py
  WorkToBeDone.md
  Xstudio_Xbatch_Schema_2026-05-22_09-15-29.md
  Xstudio_Xbatch_StoredProcedures_2026-05-22_09-18-05.md
```

Important notes:

- `WorkToBeDone.md` contains the detailed phase-by-phase file/change table.
- `HANDOFF.md` may contain prior context. Read it before implementing.
- `FrontEndDesignSkill.md` contains design guidance. Use it for frontend design quality.
- `Log View Sample Data.xlsx` and `Detailed Log View Data 10000 Rows.xlsx` are sample/support files only. Do not make Excel the runtime source unless explicitly asked.
- Runtime trace data must come from SQL or `data/tracer.sqlite`.
- Do not edit `web/vendor/three.module.js`.

---

# 4. Current runtime

## URL

```text
http://127.0.0.1:8765
```

The screenshot currently shows the app running at:

```text
localhost:8765
```

## Server entrypoint

```text
server.py
```

## Backend package

```text
tracer/
```

## Frontend package

```text
web/
```

## Local cache

```text
data/tracer.sqlite
```

## Vendored Three.js

```text
web/vendor/three.module.js
```

---

# 5. Current major files and responsibilities

## `server.py`

Primary local HTTP server.

Current responsibilities:

- Serves `web/index.html` and frontend assets.
- Exposes API routes.
- Uses `ThreadingHTTPServer`.
- Keeps an in-memory runtime log.
- Creates SQL client.
- Opens SQLite cache connection.
- Routes API calls to `tracer.cache`, `tracer.analyzer`, `tracer.parsers`, and `tracer.sql_client`.

Current important routes:

```text
GET  /api/health
GET  /api/runtime/logs
POST /api/sync
GET  /api/trace/summary
GET  /api/trace/events
GET  /api/workflows
GET  /api/workflows/{name}
GET  /api/analytics
GET  /api/playback
```

Important current behavior:

- Page load is cache-first.
- Live SQL scans are deferred.
- `/api/trace/summary` does not do a broad live SQL scan.
- Live SQL is accessed only by explicit sync or `source=sql` filters.

Do not regress this behavior.

---

## `tracer/config.py`

Configuration and paths.

Current responsibilities:

- Defines project root.
- Defines web root.
- Defines data root.
- Defines SQLite cache path.
- Defines stored-procedure Markdown path.
- Defines schema Markdown path.
- Defines trace view name.
- Reads SQL connection environment variables.

Important current paths:

```python
DB_PATH = DATA_ROOT / "tracer.sqlite"
SP_DOC_PATH = ROOT / "Xstudio_Xbatch_StoredProcedures_2026-05-22_09-18-05.md"
SCHEMA_DOC_PATH = ROOT / "Xstudio_Xbatch_Schema_2026-05-22_09-15-29.md"
TRACE_VIEW = "dbo.XStudio_List_XMES_Log_Trn_Tbl_Vw"
TRACE_DATABASE = os.environ.get("TRACER_SQL_DATABASE", "XStudio_Xbatch")
```

Future changes:

- Add feature flags and thresholds here.
- Do not hardcode thresholds in random frontend/backend functions.
- Examples:
  - focused graph max nodes
  - neighbourhood depth
  - run gap threshold
  - slow gap threshold
  - playback max events
  - prediction minimum support count

---

## `tracer/sql_client.py`

SQL access layer.

Current responsibilities:

- Uses `sqlcmd`.
- Runs SQL queries.
- Converts SQL JSON output into Python objects.
- Queries trace columns.
- Gets trace overview.
- Gets top names.
- Gets type counts.
- Gets step counts.
- Gets recent/filtered events.
- Gets events after watermark for sync.

Important current behavior:

- Uses `FOR JSON PATH, INCLUDE_NULL_VALUES`.
- `filtered_events()` supports filters:
  - name
  - type
  - start
  - end
  - SrNo
  - SubSeqNo
  - Step contains
  - general search across step/query/details
- `events_after()` supports incremental/recent sync behavior.

Future changes:

- Add bounded run-window queries.
- Add candidate run grouping queries.
- Add SQL query labels/timing later during observability phase.
- Do not make broad SQL scans happen on page load.

---

## `tracer/cache.py`

SQLite cache layer.

Current responsibilities:

- Connects to SQLite.
- Initializes cache schema.
- Stores trace events.
- Stores parsed procedure metadata.
- Stores sync state.
- Stores anomalies.
- Returns cached summaries.
- Returns cached filtered events.
- Returns procedure metadata.

Current important tables:

```sql
trace_events
procedure_metadata
sync_state
anomalies
```

Important current indexes:

```sql
idx_trace_time
idx_trace_name_type
idx_trace_sequence
```

Future changes:

- Add expected-path tables.
- Add actual-run tables.
- Add run-delta tables.
- Add prediction baseline tables.
- Add table metadata.
- Optional later: runtime event persistence.

Migration rule:

- Use `CREATE TABLE IF NOT EXISTS`.
- Do not drop existing user cache data.
- If changing schema, make it additive.
- Keep old data readable.

---

## `tracer/parsers.py`

Static source parser.

Current responsibilities:

- Reads stored-procedure Markdown.
- Finds procedure blocks.
- Extracts:
  - calls
  - reads
  - inserts
  - updates
  - log references
  - expected-ish steps from `XMES_Log_trn_Tbl` references
- Parses schema row counts.

Current limitations:

- Expected steps are rough.
- Dependencies are procedure-level, not step-level.
- Parameters are not fully parsed.
- Error-handler context is not fully parsed.
- Table metadata parsing is minimal.

Future changes:

- Create a richer expected-path model.
- Attach nearby reads/writes/calls to expected steps.
- Extract parameters.
- Extract error context.
- Extract confidence levels.
- Expand schema parser for table metadata.

---

## `tracer/analyzer.py`

Analysis, graph, anomaly, playback logic.

Current responsibilities:

- Builds analytics metrics.
- Builds anomaly list.
- Builds graph payload.
- Builds playback payload.
- Learns simple transition frequencies.
- Performs simple parameter intelligence.

Current analytics include:

- cache row count
- anonymous row count
- incomplete runs
- step gaps
- step catalog
- step coverage
- slow gaps
- rare paths
- broken instrumentation
- noisy names
- recent error handlers

Current graph payload includes:

- procedure nodes
- static step nodes
- table/entity nodes
- unknown/anonymous nodes
- procedure call edges
- read/write/update edges
- static step edges
- unknown/trace nodes

Current playback payload includes:

- expected rows
- actual rows
- missing expected
- unexpected actual
- learned transitions
- parameter intelligence
- summary counts

Current limitations:

- Graph payload is too broad and not focused.
- Node/edge metadata is not rich enough for frontend focus/inspection.
- Playback is not timeline-ready.
- There is no true run reconstruction.
- Delta matching is simple, not layered.
- Predictions are basic and not explainable enough.

Future changes:

- Add display metadata to nodes/edges.
- Add focused graph defaults.
- Add expected path payload.
- Add run reconstruction.
- Add delta engine.
- Add timeline-ready playback.
- Add prediction baselines.
- Add evidence payloads.
- Add report payloads.

---

## `web/index.html`

Frontend structure.

Current responsibilities:

- Defines left rail.
- Defines filters.
- Defines graph canvas.
- Defines graph controls.
- Defines top stats.
- Defines bottom tab strip.
- Defines modal inspector.
- Loads `app.js`.

Current visible controls:

- SP name
- Trace type
- Source cache/live SQL
- Limit
- From/To
- SrNo/SubSeqNo
- Step contains
- Search evidence
- Apply
- What is wrong?
- Runtime log
- SP map
- Sync latest rows
- Graph view mode
- Reset/top/front
- Export PNG
- Playback

Current issue:

- Main screen still feels like a dashboard and graph object pile.
- Bottom tabs consume space even when empty.
- Legend takes permanent left-rail space.
- There is no focused run selector yet.
- There is no timeline rail yet.
- There is no graph-scope selector yet.

Future changes:

- Add graph scope selector.
- Reorganize left rail into investigation sections.
- Add run selector.
- Replace bottom tabs with diagnostic drawer.
- Add timeline controls.
- Add export modal.
- Expand evidence modal.

---

## `web/styles.css`

Frontend styling.

Current responsibilities:

- Defines industrial/dark theme.
- Defines left rail layout.
- Defines workspace grid.
- Defines graph controls.
- Defines bottom tabs.
- Defines table styling.
- Defines modal styling.
- Defines severity classes.

Current issue:

- Layout is functional but too dense.
- Bottom strip fixed height reduces graph workspace.
- Legend occupies permanent screen area.
- Controls are not organized around investigation flow.
- No timeline styling.
- No evidence-card styling.
- No export/report styling.

Future changes:

- Add collapsible diagnostic drawer.
- Add lane/key/overlay styling.
- Add timeline styling.
- Add evidence cards.
- Add delta badges.
- Add report/export styling.
- Later add runtime timeline styling.

---

## `web/app.js`

Main frontend logic.

Current responsibilities:

- Stores frontend state.
- Calls APIs.
- Renders summary.
- Renders filters.
- Sets up graph.
- Renders graph.
- Handles camera controls.
- Handles selection.
- Renders analytics tables.
- Renders events.
- Renders runtime log.
- Opens SP map modal.
- Opens inspector modal.
- Exports graph PNG.
- Calls playback API.
- Renders playback as table/JSON.

Current graph capabilities:

- Three.js scene/camera/renderer.
- Manual drag rotate.
- Shift-drag pan.
- Wheel zoom.
- Top/front/reset controls.
- Different graph modes:
  - workflow
  - steps
  - damage
- Different object shapes:
  - normal SP
  - workflow SP
  - error/API path
  - internal step
  - table/entity read/write/update
  - unknown/anonymous
- Graph PNG export.

Current issue:

- Default graph shows too many nodes.
- Labels are too noisy.
- Edge hairball makes relationships hard to understand.
- Selection visual is too heavy.
- `wrongMode` is not yet a full diagnostic workflow.
- Playback is not visual.
- Inspector is still partly JSON/evidence dump style.
- No edge selection.
- No run selector.
- No true timeline state.

Future changes:

- This is the highest-change frontend file.
- Most visual/product work happens here.
- Make changes in small increments and validate after each one.

---

## `web/vendor/three.module.js`

Vendored Three.js library.

Rule:

```text
Do not edit this file.
```

All graph behavior should be implemented in `web/app.js`.

---

## Markdown source files

### `Xstudio_Xbatch_StoredProcedures_2026-05-22_09-18-05.md`

Static stored-procedure source.

Use for:

- expected path
- expected log points
- SP calls
- table reads
- table inserts
- table updates
- parameters
- error branches
- source excerpts

Do not edit this file.

### `Xstudio_Xbatch_Schema_2026-05-22_09-15-29.md`

Static schema source.

Use for:

- table metadata
- row counts
- primary keys
- columns
- date ranges
- table inspector evidence

Do not edit this file.

---

## Excel files

### `Log View Sample Data.xlsx`

Sample-only data.

### `Detailed Log View Data 10000 Rows.xlsx`

Sample/support data.

Rules:

- Do not switch runtime source from SQL/cache to Excel.
- Use Excel only for visual comparison, smoke testing, or sample validation if explicitly needed.
- Runtime source remains SQL view + SQLite cache.

---

# 6. What is already built

## Backend

Already implemented:

- Local Python HTTP server.
- Cache-first startup.
- SQL client using `sqlcmd`.
- SQLite cache.
- Trace-event sync.
- Cached summary.
- Cached and live filtered events.
- Stored-procedure parser.
- Schema parser basics.
- Workflow graph payload.
- Analytics/anomaly metrics.
- Playback endpoint groundwork.
- Runtime log endpoint.

## Frontend

Already implemented:

- Plain HTML/CSS/JS.
- Three.js graph.
- 3D camera controls.
- Graph modes:
  - Workflow Map
  - Step Tower
  - Damage Focus
- Filters:
  - SP name
  - type
  - cache/live SQL
  - limit
  - time window
  - SrNo/SubSeqNo
  - step contains
  - evidence search
- Sync latest trace rows.
- Node inspector modal.
- SP map modal.
- Runtime modal groundwork.
- PNG export.
- Playback button and table/JSON renderer.
- Distinct object shapes.
- Damage/analytics tabs.

---

# 7. Current product problem

The current UI technically contains a lot of useful pieces, but visually it still reads as a dense 3D object pile.

Observed current problems from screenshots:

```text
- Around 210 nodes visible in graph.
- Too many edges shown simultaneously.
- Labels overlap.
- Long IDs/GUID-like labels dominate the scene.
- The selected blue beacon is too large.
- Bottom tab area consumes height even when empty.
- Left rail includes permanent legend and static explanations.
- Graph modes change layout but do not yet guide diagnosis.
- Playback is not yet a visual experience.
```

The first improvement must be:

```text
Graph readability and semantic clarity.
```

Not playback.

Not ML.

Not observability.

If users cannot understand the graph, later playback and prediction will only add more confusion.

---

# 8. Non-regression rules

## Runtime/source rules

1. Do not make Excel the runtime source.
2. Do not run broad live SQL scans on page load.
3. Keep startup cache-first.
4. Live SQL must remain explicit:
   - sync button
   - source=Live SQL filter
   - bounded live query
5. Do not remove cache mode.
6. Do not remove the ability to use live SQL filters.

## Graph rules

1. Do not remove existing shape semantics.
2. Color should encode state/severity.
3. Shape should encode object type.
4. Do not show all nodes by default.
5. Do not permanently occupy the screen with static SP map.
6. Do not make the graph dependent on playback being available.
7. Do not remove manual camera controls.
8. Do not modify Three.js vendor file.

## UI rules

1. Graph remains the main workspace.
2. Left rail should be for investigation controls, not permanent documentation.
3. Empty bottom panels should not dominate the screen.
4. Clicking visual elements must lead to evidence.
5. Raw JSON can exist, but must not be the primary user-facing evidence view.
6. Observability is last-stage work, not first-stage work.

## Backend rules

1. Additive schema migrations only.
2. Existing `trace_events` data must remain readable.
3. Existing `/api/trace/summary`, `/api/trace/events`, `/api/workflows`, `/api/analytics`, and `/api/playback` should not be broken.
4. New endpoints should be added without removing old ones unless the frontend is updated safely.
5. Keep responses JSON-serializable.
6. Keep SQL queries bounded.

---

# 9. Master backlog location

The detailed work table is saved in:

```text
WorkToBeDone.md
```

It contains phase-by-phase rows with:

```text
Phase
File
Aspect
Change Broad Info
Details
```

Before coding, read:

```text
HANDOFF.md
WorkToBeDone.md
FrontEndDesignSkill.md
```

Then inspect:

```text
server.py
tracer/config.py
tracer/cache.py
tracer/parsers.py
tracer/analyzer.py
tracer/sql_client.py
web/index.html
web/styles.css
web/app.js
```

---

# 10. Implementation phases

The project plan has 10 phases.

## Phase 1 — Graph readability and semantic clarity

Objective:

```text
Turn the current 3D graph from a cluttered object cloud into a legible diagnostic map.
```

Must implement first.

Main changes:

- Default to focused graph, not all nodes.
- Add graph scope selector:
  - Focused Run
  - Selected SP
  - Neighbourhood
  - All System
- Use strong semantic lanes.
- Hide most labels by default.
- Reduce edge hairballs.
- Bundle repeated edges.
- Replace oversized selected beacon.
- Make “What is wrong?” filter the graph to damage.
- Move legend/map key out of permanent left rail.

Primary files:

```text
web/app.js
web/index.html
web/styles.css
tracer/analyzer.py
```

Completion criteria:

```text
- Default screen is understandable without opening legend.
- No unreadable edge hairball in default view.
- SP/table/error/step nodes are visually distinct.
- Selection makes nearby relationships clearer.
- Live SQL and cache filters still work.
```

---

## Phase 2 — Investigation-oriented layout

Objective:

```text
Make the page feel like a tracer, not a database dashboard.
```

Main changes:

- Collapse left rail into investigation sections.
- Replace bottom tabs with collapsible diagnostic drawer.
- Promote “What is wrong?” into a real diagnostic mode.
- Diagnosis list should focus graph nodes on click.

Primary files:

```text
web/index.html
web/styles.css
web/app.js
tracer/analyzer.py
server.py
```

Completion criteria:

```text
- Empty bottom panels do not dominate screen.
- User can start with “What is wrong?” and reach evidence in two clicks.
- Graph remains main workspace.
```

---

## Phase 3 — Expected-path model

Objective:

```text
Create a clean “what should have happened” path from stored procedure knowledge.
```

Main changes:

- Richer `ProcedureInfo`.
- Richer step extraction.
- Step-level table touches.
- Step-level child SP calls.
- Error context.
- Parameters.
- Expected-path cache table.
- `/api/expected-path`.
- Expected Path graph mode.

Primary files:

```text
tracer/parsers.py
tracer/cache.py
tracer/analyzer.py
server.py
web/index.html
web/app.js
web/styles.css
```

Completion criteria:

```text
- Selected SP can show ordered expected path.
- Expected steps are inspectable.
- Expected Path mode does not require actual logs.
```

---

## Phase 4 — Actual-run reconstruction

Objective:

```text
Turn raw trace rows into actual execution runs.
```

Main changes:

- Add actual run model.
- Add actual run event model.
- Group logs by name/type/execution query/time sequence.
- Add run selector.
- Add `/api/runs`.
- Add `/api/runs/{run_id}`.

Primary files:

```text
tracer/cache.py
tracer/analyzer.py
tracer/sql_client.py
server.py
web/index.html
web/app.js
web/styles.css
```

Completion criteria:

```text
- User can select a specific run.
- App can show run start/end/duration/status.
- Runs of same SP do not mix together.
```

---

## Phase 5 — Expected vs actual delta engine

Objective:

```text
Compare what should have happened against what actually happened.
```

Main changes:

- Layered matching:
  - exact SrNo/SubSeqNo
  - text similarity
  - ordinal proximity
  - sequence position
  - time adjacency
- Formal delta records.
- Missing/unexpected/out-of-order/duplicate/slow/error/incomplete deltas.
- `/api/delta`.
- Delta-driven “What is wrong?” mode.

Primary files:

```text
tracer/analyzer.py
tracer/cache.py
server.py
web/app.js
web/index.html
web/styles.css
```

Completion criteria:

```text
- Clear delta list for selected run.
- Each delta links to graph, timeline, and raw evidence.
- “What is wrong?” uses delta engine when run is selected.
```

---

## Phase 6 — Visual playback MVP

Objective:

```text
Create the first real visual playback experience.
```

Main changes:

- Timeline-ready playback payload.
- Playback clock.
- Timeline rails:
  - Expected
  - Actual
  - Predicted
- Play/pause/speed/scrubber.
- Graph synchronized to timeline.
- Active edge bead.
- Missing/unexpected/slow/error visual markers.

Primary files:

```text
tracer/analyzer.py
server.py
web/index.html
web/app.js
web/styles.css
```

Completion criteria:

```text
- User can scrub through a run.
- Graph and timeline remain synchronized.
- Missing/unexpected/slow/error visible without reading table.
```

---

## Phase 7 — Prediction and lightweight ML intelligence

Objective:

```text
Predict what should happen next and flag abnormal behavior.
```

Do not start with heavy ML.

Use explainable statistical baselines first.

Main models:

- Transition model.
- Parameter-shape model.
- Timing model.
- Completion model.

Primary files:

```text
tracer/analyzer.py
tracer/cache.py
server.py
web/app.js
web/styles.css
```

Completion criteria:

```text
- App can predict likely next step with confidence.
- Prediction has explanation.
- Static expected and learned prediction are visually separate.
```

---

## Phase 8 — Evidence-first inspection

Objective:

```text
Every visual element should explain why it exists.
```

Main changes:

- Edge selection.
- Structured evidence cards.
- Better SP inspector.
- Better table inspector.
- Better step inspector.
- Better edge inspector.
- `/api/evidence`.
- Table metadata parsing/cache.

Primary files:

```text
web/app.js
web/index.html
web/styles.css
tracer/parsers.py
tracer/cache.py
tracer/analyzer.py
server.py
```

Completion criteria:

```text
- No graph element is a mystery.
- Clicking object answers “why is this here?”
- Raw JSON is available but not primary.
```

---

## Phase 9 — Export and reporting

Objective:

```text
Export the investigation, not just the canvas.
```

Main changes:

- Better graph PNG export.
- Timeline PNG export.
- Diagnostic report payload.
- CSV delta export.
- Evidence bundle.
- Print/report styling.

Primary files:

```text
web/app.js
web/index.html
web/styles.css
tracer/analyzer.py
tracer/cache.py
server.py
```

Completion criteria:

```text
- Exported image/report includes title, filters, selected SP/run, timestamp, legend.
- User can share output and another person can understand it.
```

---

## Phase 10 — Middle-layer observability

Objective:

```text
Show how the app itself loaded/refreshed/queried/rendered.
```

Keep this last.

Main changes:

- Request IDs.
- Server request metadata.
- SQL timing metadata.
- Browser boot/render timing.
- Runtime panel with filters.
- Optional runtime persistence.

Primary files:

```text
server.py
tracer/sql_client.py
tracer/cache.py
web/app.js
web/index.html
web/styles.css
```

Completion criteria:

```text
- Refresh shows clear boot trace.
- User can see browser/server/sql/cache path.
- Errors are easy to identify.
```

---

# 11. Immediate next task

Start with:

```text
Phase 1 — Graph readability and semantic clarity.
```

Do not start with playback or observability.

The first visible improvement must be:

```text
When the page opens, it should show one understandable focused process map, not the full system graph.
```

Recommended first implementation sequence:

```text
1. Add graph scope state in web/app.js.
2. Add graph-scope selector in web/index.html.
3. Default focused node to dominant SP from summary.
4. Change filteredNodes() to show focused neighbourhood by default.
5. Change filteredEdges() to only show important focused edges.
6. Hide labels except selected/hover/focused/error/high-volume.
7. Replace selected blue beacon with subtle ring/outline.
8. Move legend into Map Key modal.
9. Add lane floor bands.
10. Validate live SQL/cache filters still work.
```

---

# 12. Phase 1 detailed implementation notes

## 12.1 Add graph scope state

In `web/app.js`, extend state:

```js
graphScope: "focused",
focusedNodeId: "",
hoveredNodeId: "",
showLabels: "smart",
edgeVisibility: "focused",
damageOnly: false,
```

Do not remove existing:

```js
viewMode
wrongMode
filters
selected
playback
```

## 12.2 Add graph scope selector

In `web/index.html`, add near the graph controls:

```html
<select id="graph-scope">
  <option value="focused">Focused SP</option>
  <option value="selected">Selected SP</option>
  <option value="neighbourhood">Neighbourhood</option>
  <option value="all">All System</option>
</select>
```

Wire it in `bindActions()`.

## 12.3 Set default focus

In `loadAll()` after summary loads:

```js
state.focusedNodeId = state.summary?.cache?.top_names?.[0]?.name || "";
```

But make sure node IDs and SP names match graph node IDs. If not, normalize by looking up matching node.

## 12.4 Replace all-node default

Current mental model:

```text
visibleIds = all graph nodes
then filter down
```

New mental model:

```text
visibleIds = focused semantic neighbourhood
then expand if user asks
```

Rules:

- focused = dominant/focused SP + direct important neighbours.
- selected = selected node + direct neighbours.
- neighbourhood = two-hop neighbourhood.
- all = current all-system behavior.
- damage = damage nodes + connected context.

## 12.5 Edge priority

Add an edge priority function:

```text
error/update/write/call > read > static_step > weak
```

In focused mode:

- Always show edge if connected to focused/selected/current damage.
- Show writes/updates/calls.
- Fade reads.
- Hide static step edges unless selected or in Step Tower mode.
- Bundle repeated edges.

## 12.6 Smart labels

Add:

```js
function shouldShowLabel(node) { ... }
```

Show label if:

```text
selected
hovered
focused
error
unknown
high trace count
high damage
current playback event
```

Do not show labels for every table/SP by default.

## 12.7 Selection visual

Replace large blue beacon with:

```text
thin outline
small vertical marker
base ring
selected label card
```

Do not cover the selected object.

## 12.8 Lane bands

Add floor swimlanes:

```text
Procedure
Workflow/API
Internal Step
Table/Entity
SAP/API/Error
Unknown
```

Use transparent floor rectangles or planes.

---

# 13. Validation commands

Run these after changes.

## JavaScript syntax

Use the local Node path if available:

```powershell
& "C:\Users\Admin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" --check web\app.js
```

Fallback:

```powershell
node --check web\app.js
```

## Python syntax

Use the local Python path if available:

```powershell
& "C:\Users\Admin\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe" -m py_compile server.py tracer\config.py tracer\sql_client.py tracer\cache.py tracer\parsers.py tracer\analyzer.py
```

Fallback:

```powershell
python -m py_compile server.py tracer\config.py tracer\sql_client.py tracer\cache.py tracer\parsers.py tracer\analyzer.py
```

## API smoke tests

With server running:

```powershell
Invoke-RestMethod http://127.0.0.1:8765/api/health
Invoke-RestMethod http://127.0.0.1:8765/api/trace/summary
Invoke-RestMethod http://127.0.0.1:8765/api/workflows
Invoke-RestMethod http://127.0.0.1:8765/api/analytics
Invoke-RestMethod "http://127.0.0.1:8765/api/trace/events?limit=50"
Invoke-RestMethod "http://127.0.0.1:8765/api/playback?name=XMES_I_API_Transaction_Summary&type=RR&limit=50"
```

Do not run unbounded live SQL scans as a smoke test.

---

# 14. Manual UI validation checklist

After Phase 1 changes:

```text
[ ] App loads at http://127.0.0.1:8765.
[ ] Page opens in cache-first mode.
[ ] Default graph is focused, not all nodes.
[ ] Node count is significantly reduced from all-system view.
[ ] User can switch to All System manually.
[ ] Graph still supports Workflow Map, Step Tower, Damage Focus.
[ ] Focused SP is visually clear.
[ ] Tables are visually distinct from SPs.
[ ] Error/API nodes are visually distinct.
[ ] Unknown/anonymous nodes are visually distinct.
[ ] Edge hairball is reduced in focused mode.
[ ] Labels do not overlap heavily.
[ ] Hover/select makes relationship clearer.
[ ] Selected node marker does not cover the node.
[ ] What is wrong? mode narrows to damage context.
[ ] Cache filters still work.
[ ] Live SQL filter still works when selected explicitly.
[ ] Export PNG still works.
[ ] SP Map still opens from button/modal.
[ ] Runtime log can remain as-is for now.
```

---

# 15. Coding style and safety rules

## General

- Keep the stack simple.
- Do not introduce React/Vite/build tooling unless explicitly requested.
- Current stack is Python + plain HTML/CSS/JS + Three.js.
- Avoid large rewrites in one step.
- Prefer additive functions over replacing working code.
- Keep frontend state explicit and inspectable.
- Keep API responses plain JSON.

## Backend

- Keep SQL bounded.
- Keep cache-first behavior.
- Use `sqlite3.Row`.
- Use additive schema migrations.
- Keep existing endpoints working.
- Avoid hidden background work.
- Avoid long startup tasks.

## Frontend

- Do not make the graph dependent on hidden panels.
- Do not make raw JSON the primary UX.
- Add small helper functions:
  - `resolveFocusNode()`
  - `graphScopeVisibleIds()`
  - `edgePriority()`
  - `shouldShowEdge()`
  - `shouldShowLabel()`
  - `nodeDisplayName()`
  - `applySelectionMarker()`
- Keep camera controls stable.
- Avoid modifying Three.js vendor file.

---

# 16. Suggested new helper functions

Implement these gradually in `web/app.js`.

```js
function resolveDefaultFocus() {}
function resolveNodeIdFromName(name) {}
function graphScopeVisibleIds() {}
function neighbourhoodIds(seedIds, depth) {}
function edgePriority(edge) {}
function shouldShowEdge(edge, visibleIds) {}
function shouldShowLabel(node) {}
function nodeDisplayName(node) {}
function createLaneBands(lanes) {}
function createSelectionMarker(mesh, node) {}
function focusNode(nodeId, options = {}) {}
function focusDiagnosis(diagnosis) {}
```

Avoid overloading `renderGraph()` with all logic. Use small helpers.

---

# 17. Suggested backend additions

For Phase 1 only, keep backend additions minimal.

In `tracer/analyzer.py`, enrich graph nodes/edges:

Node metadata:

```json
{
  "id": "...",
  "label": "...",
  "display_label": "...",
  "short_label": "...",
  "kind": "...",
  "shape": "...",
  "lane": "...",
  "trace_count": 123,
  "importance": 0.83,
  "severity": "medium",
  "is_damage": true,
  "is_dominant": false,
  "degree": 5
}
```

Edge metadata:

```json
{
  "source": "...",
  "target": "...",
  "kind": "write",
  "label": "writes",
  "priority": 80,
  "style": "strong",
  "weight": 1,
  "evidence_type": "static"
}
```

Graph payload metadata:

```json
{
  "nodes": [],
  "edges": [],
  "default_focus": {
    "node_id": "XMES_I_API_Transaction_Summary",
    "reason": "dominant_trace_volume",
    "connected_node_ids": []
  }
}
```

If backend metadata is not ready, the frontend may compute fallback metadata. Do not block Phase 1 on perfect backend enrichment.

---

# 18. Expected UX after Phase 1

Initial screen should look like this conceptually:

```text
Left:
  Run/trace filters
  Actions

Top:
  Dominant SP | Top Type | Open Damage | Watermark

Center:
  Focused semantic graph
  Dominant SP centered
  Direct calls nearby
  Table reads/writes/updates in table lane
  Error/unknown nodes isolated
  Few meaningful edges only

Bottom:
  Collapsed or compact diagnostic drawer
  Not a large empty table strip

Modal:
  Map key / SP map / Inspector only on demand
```

The user should not have to decode 210 nodes to begin.

---

# 19. How to use `WorkToBeDone.md`

`WorkToBeDone.md` is intentionally detailed and file-specific.

Recommended use:

1. Pick one phase.
2. Filter only rows for that phase.
3. Implement in the order:
   - backend data shape if required
   - HTML controls if required
   - CSS layout if required
   - JS behavior/rendering
   - smoke tests
4. Do not mix phases unless a tiny supporting change is needed.
5. After each phase, update `HANDOFF.md` with:
   - what changed
   - files touched
   - tests run
   - known issues
   - next recommended work

For the next coding session, use only Phase 1 rows from `WorkToBeDone.md`.

---

# 20. Do not do these yet

Do not start with:

```text
- Observability overhaul
- Heavy ML model
- PDF export
- React migration
- New backend framework
- New database
- Excel runtime ingestion
- Full report generator
- Large SQL live scans
```

These are either later-phase items or outside the intended simple-stack approach.

---

# 21. Current priority stack

Use this order:

```text
1. Phase 1 — focused semantic graph
2. Phase 2 — investigation layout
3. Phase 8 partial — better inspector basics, if needed for graph clarity
4. Phase 3 — expected path model
5. Phase 4 — actual runs
6. Phase 5 — delta engine
7. Phase 6 — visual playback
8. Phase 7 — prediction
9. Phase 9 — export/reporting
10. Phase 10 — observability
```

Reason for moving a small part of Phase 8 earlier:

```text
Graph readability improves faster if clicking a node can explain what it is.
```

But do not build the full evidence system before Phase 1.

---

# 22. Final instruction to implementation agent

Start by making the graph understandable.

The first deliverable is not a new algorithm. It is a better first screen.

A successful first PR/change set should make the current screenshots noticeably cleaner:

```text
- fewer visible nodes by default
- fewer visible edges by default
- less label clutter
- clearer lanes
- subtle selected node marker
- clear focused SP
- easy switch to all-system view
```

After that, continue phase by phase using `WorkToBeDone.md`.
