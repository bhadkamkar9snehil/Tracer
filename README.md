# Tracer

Tracer is a local execution-analysis application for high-volume XStudio/XMES trace logs. It reconstructs individual runs, learns the dominant sequence and timing behaviour of comparable runs, and presents deviations as a coordinated 2D investigation workspace.

The application is intentionally cache-first. It remains usable when SQL Server is unavailable and always displays the age of the cached evidence.

## What it provides

- Run-by-step deviation matrix for hundreds of executions at once.
- Sortable run inbox with plain-language explanations and exact matrix-row focus.
- Expected-versus-actual waterfall for a selected execution.
- Raw event evidence, including sequence numbers and execution query.
- Clickable sequence-variant frequency analysis that filters to an exact execution path.
- Per-step median, p95, p99, and maximum latency analysis.
- Execution, deviation, and failure density over time.
- Filters for inclusive date range, procedure, type, status, KPI signal, exact sequence variant, and run ordering.
- Resizable inbox, evidence, matrix, and bottom-analysis panels with per-browser layout persistence.
- CSV export of the currently visible executions.
- Explicit, bounded SQL synchronization into a local SQLite cache.
- Responsive layouts for small laptops and desktop monitors. The supported minimum width is 1024 pixels; mobile phones are not a target surface.

## Deviation model

Runs are compared only with runs sharing the same procedure and trace type. Tracer explains:

- error, incomplete, orphan, and unknown outcomes;
- missing expected steps;
- unexpected steps;
- reordered steps;
- repeated steps and retry-like behaviour;
- step latency beyond the cohort p95;
- rare execution sequences.

The dominant observed sequence becomes the cohort baseline. The UI does not treat an opaque model score as evidence: every non-zero score is accompanied by the concrete conditions that produced it.

## Requirements

- Windows PowerShell or another terminal.
- Python 3.11 or newer.
- A modern Chromium-based browser.
- Optional for live synchronization: Microsoft `sqlcmd` plus read access to `XStudio_Xbatch.dbo.XStudio_List_XMES_Log_Trn_Tbl_Vw`.

The application itself uses only the Python standard library. No `pip install` step is required.

## Run locally

From PowerShell:

```powershell
cd C:\Users\Admin\Documents\Office\Tracer
python -m unittest discover -s tests -v
python server.py
```

Open:

```text
http://127.0.0.1:8765
```

Stop the server with `Ctrl+C`.

If `python` is not on `PATH`, use the installed Python executable explicitly:

```powershell
& "C:\Path\To\python.exe" -m unittest discover -s tests -v
& "C:\Path\To\python.exe" server.py
```

Custom host or port:

```powershell
python server.py --host 127.0.0.1 --port 9000
```

Then open `http://127.0.0.1:9000`.

## First run and local data

Tracer stores runtime data in:

```text
data\tracer.sqlite
```

That file is deliberately excluded from Git because it can contain environment-specific operational evidence.

- In this workspace, the existing cache is loaded automatically.
- With an empty cache, the application displays a valid empty state.
- To populate an empty cache, configure read-only SQL access, start Tracer, and press **Sync**.
- Each sync reads at most 5,000 trace rows and then reconstructs new runs locally.

## Configure optional SQL synchronization

Set variables in the same PowerShell window before starting the server:

```powershell
$env:TRACER_SQL_SERVER = "YOUR_SQL_SERVER_HOSTNAME"
$env:TRACER_SQL_USER = "YOUR_READ_ONLY_USER"
$env:TRACER_SQL_PASSWORD = "YOUR_PASSWORD"
$env:TRACER_SQL_DATABASE = "XStudio_Xbatch"
$env:TRACER_SQLCMD = "sqlcmd"
python server.py
```

Use the verified SQL Server hostname required by TLS. Do not place credentials in source files, `.env.example`, shell history, screenshots, or Git.

Tracer uses SQL only for bounded reads. All reconstruction, baselines, scoring, and analysis are written to the local SQLite cache.

## How to test the product manually

1. Confirm the header shows the correct cache state and watermark.
2. Select **Error** under Outcome and confirm the four KPI counts recalculate for that outcome.
3. Click **Deviated**, **Failed**, or **Slow** to filter every analysis panel to that KPI population; click **Executions** to show all matching runs.
4. Change **Sort runs by** and confirm it changes the run order without changing the KPI population.
5. Select a run from the left inbox. Confirm its exact matrix row is selected and brought into view while the matrix header and page remain fixed.
6. Click a **Sequence variants** row to restrict the inbox, matrix, density, and latency analysis to runs with that exact path; use **Clear variant** to return to the KPI population.
7. Open **Explanation**, **Waterfall**, and **Raw evidence** in the inspector.
8. Click different matrix rows and confirm the inspector changes.
9. Filter to one procedure and type; confirm the available types narrow to that procedure and the matrix columns change from normalized positions to semantic steps.
10. Drag each panel divider, reload the page, and confirm the browser restores the chosen layout. Use arrow keys while a divider is focused for precise adjustment; press **Home** or double-click to reset it.
11. Press **Export** and open the generated CSV.
12. If read-only SQL is configured, press **Sync** and confirm the watermark advances or the UI reports that no new rows were found.

## Automated validation

```powershell
python -m unittest discover -s tests -v
python -m py_compile server.py tracer\atlas.py tracer\analyzer.py tracer\cache.py tracer\config.py tracer\parsers.py tracer\sql_client.py
node --check web\app.js
```

API smoke checks while the server is running:

```powershell
Invoke-RestMethod http://127.0.0.1:8765/api/health
Invoke-RestMethod http://127.0.0.1:8765/api/atlas
Invoke-RestMethod "http://127.0.0.1:8765/api/atlas?status=error&sort=deviation"
```

## API

| Route | Purpose |
|---|---|
| `GET /api/health` | Cache, configuration, and runtime health |
| `GET /api/atlas` | Coordinated summary, density, matrix, variants, and latency contract |
| `GET /api/atlas/runs/{run_id}` | Explainable selected-run comparison and raw evidence |
| `POST /api/sync?limit=5000&mode=incremental` | Bounded read-only SQL synchronization |
| `GET /api/trace/events` | Cached or explicitly requested live events |
| `GET /api/runs` | Reconstructed run list |

Supported `/api/atlas` query parameters:

```text
name, type, status, start, end, sort, limit, signal, variant, run
```

`start` and `end` accept `YYYY-MM-DD`; both selected calendar days are inclusive.

`signal` accepts `all`, `deviated`, `failed`, or `slow`. `variant` is the stable ID returned by the sequence-variant contract. `run` focuses a run and guarantees its inclusion in the capped matrix window when it belongs to the active filters.

`limit` is bounded to 20–300 matrix rows. Analysis still covers all matching runs up to the backend safety limit; only the interactive matrix is capped. The run inbox reports both shown and total counts when its separate safety cap is reached.

## Architecture

```text
XStudio trace view (optional bounded read)
  -> SQLite trace_events
  -> heuristic run reconstruction
  -> procedure/type cohort baselines
  -> explainable deviation analysis
  -> coordinated local browser workspace
```

- `server.py`: local HTTP and JSON API server.
- `tracer/atlas.py`: cohort baselines, deviation explanations, density, matrix, variants, and latency contracts.
- `tracer/analyzer.py`: legacy-compatible reconstruction and supporting analysis.
- `tracer/cache.py`: SQLite schema and cache access.
- `tracer/sql_client.py`: bounded `sqlcmd` read client.
- `web/`: code-native HTML, CSS, Canvas2D, SVG, and interaction layer.
- `tests/`: standard-library regression tests.

## Interpretation boundaries

- A cohort baseline is historical behaviour, not proof that the behaviour is correct.
- Small cohorts cannot support reliable rarity or percentile conclusions; Tracer suppresses some signals until enough comparable runs exist.
- Run reconstruction is heuristic because the source trace does not always expose a durable transaction/session key.
- A stale cache is still displayed, but it is explicitly marked stale or offline.
- Live synchronization does not change XStudio configuration or operational records.

## Troubleshooting

### Page opens but contains no executions

Check `data\tracer.sqlite`. Configure read-only SQL access and press **Sync** if the cache is empty.

### Sync reports incomplete SQL configuration

Set `TRACER_SQL_SERVER`, `TRACER_SQL_USER`, `TRACER_SQL_PASSWORD`, and `TRACER_SQL_DATABASE` in the same terminal used to launch `server.py`.

### `sqlcmd` is not found

Install Microsoft SQL command-line tools or set `TRACER_SQLCMD` to the full executable path.

### Port 8765 is already in use

```powershell
python server.py --port 9000
```

### Cache findings look old

The watermark in the header is the evidence timestamp. Configure SQL and run a bounded sync; do not interpret old cached anomalies as current operational state.

## License

Apache License 2.0. See [LICENSE](LICENSE).
