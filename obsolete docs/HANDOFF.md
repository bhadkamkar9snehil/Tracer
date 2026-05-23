# Tracer Handoff

## Current Goal
Build a local, simple-stack tracer for `XStudio_Xbatch.dbo.XStudio_List_XMES_Log_Trn_Tbl_Vw` using Python plus plain HTML/CSS/JS/Three.js. Excel is sample-only and must not be used as source data.

## Current Runtime
- App URL: `http://127.0.0.1:8765`
- Server: `server.py`
- Backend modules: `tracer/config.py`, `tracer/sql_client.py`, `tracer/cache.py`, `tracer/parsers.py`, `tracer/analyzer.py`
- Frontend: `web/index.html`, `web/styles.css`, `web/app.js`
- Local cache: `data/tracer.sqlite`
- Three.js vendored at `web/vendor/three.module.js`

## Implemented
- Cache-first page load. Live SQL scans were making startup slow, so broad live reads were removed from page load.
- Filters support cache and live SQL source, limit, date range, `SrNo`, `SubSeqNo`, step text, evidence search, SP name, and trace type.
- Manual 3D controls: drag rotate, Shift+drag pan, wheel zoom, reset/top/front buttons.
- Graph view modes: workflow, step tower, damage focus.
- Different object shapes:
  - box: normal SP
  - cylinder: workflow SP
  - pyramid: error/API path
  - thin block: internal step
  - slab/cylinder: table/entity read/update/write
  - octahedron: anonymous/unknown
- Permanent right-side rail removed. Inspector, static SP map, and runtime logs now open as modal overlays.
- Graph export button added via canvas PNG download.
- Middle-layer observability added:
  - Python API request log in `server.py`
  - `/api/runtime/logs`
  - browser request log rendered in Runtime tab and modal.
- Playback/prediction groundwork:
  - `/api/playback`
  - expected SP steps from parsed procedure code
  - actual SQL trace events from cache
  - missing expected steps
  - unexpected actual steps
  - learned transition frequencies
  - parameter shape intelligence from `ExecutionQuery`

## Important Design Decisions
- Keep startup cache-first. Live SQL should require explicit user action or bounded filters.
- Use color only for state/severity; use shape for object type.
- Do not keep static SP map permanently visible. It belongs behind the `SP map` button.
- Node inspector must explain what object was selected. Tables are not procedures and should not call `/api/workflows/{table}` as if they were SPs.
- Playback should compare three things: expected static SP path, actual trace path, and learned/predicted path from historical traces.

## Known Data Facts
- SQL view columns: `ReportDate`, `ID`, `EntryDateTime`, `Name`, `ExecutionQuery`, `Type`, `Step`, `SrNo`, `SubSeqNo`, plus helper columns.
- Live SQL previously showed `456,264` rows and `11` non-null unique SP names.
- Current cache has been seeded with recent SQL rows; sync button can refresh latest rows.

## Validation Commands
```powershell
& "C:\Users\Admin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" --check web\app.js
& "C:\Users\Admin\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe" -m py_compile server.py tracer\config.py tracer\sql_client.py tracer\cache.py tracer\parsers.py tracer\analyzer.py
Invoke-RestMethod http://127.0.0.1:8765/api/trace/summary
Invoke-RestMethod http://127.0.0.1:8765/api/analytics
Invoke-RestMethod "http://127.0.0.1:8765/api/playback?name=XMES_I_API_Transaction_Summary&type=RR&limit=50"
```

## Next Recommended Work
- Make playback visual, not just tabular: animate an expected rail and actual rail on the graph over time.
- Add a scrubber with play/pause/speed and current event evidence.
- Improve parameter anomaly scoring by learning per-SP/per-type parameter distributions over a larger synced cache.
- Add a “fetch live window” action that syncs a bounded SQL date range into cache, instead of only latest rows.
- Add edge selection/inspection, not only node selection.
- Improve graph layout to reduce edge overlap for high-degree tables.
