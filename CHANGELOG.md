# Changelog

## 1.0.0 — 2026-08-10

### Product

- Replaced the abandoned 3D graph interface with the complete 2D Execution Atlas.
- Added the run-by-step matrix, anomaly inbox, time density, sequence variants, per-step latency, selected-run waterfall, and raw evidence views.
- Added procedure, type, status, and ordering filters with URL-backed state.
- Added visible cache freshness, bounded SQL sync, CSV export, loading, empty, stale, offline, and error states.
- Added small-laptop and desktop layouts for supported widths of 1024 pixels and above.

### Analysis

- Added procedure/type cohort baselines learned from dominant execution sequences.
- Added explainable scoring for outcome, missing, unexpected, reordered, repeated, slow, and rare-path deviations.
- Added normalized ordinal matrices for cross-procedure overviews and semantic matrices for focused cohorts.
- Added p50, p95, p99, maximum, failure, deviation, density, and variant aggregations.
- Removed reliance on incomplete legacy `run_deltas` scores.

### Engineering

- Added `/api/atlas` and `/api/atlas/runs/{run_id}` contracts.
- Added host and port command-line options.
- Added standard-library automated regression coverage, including empty-cache behavior.
- Replaced placeholder documentation with complete local operation, testing, SQL configuration, API, architecture, interpretation, and troubleshooting guidance.
