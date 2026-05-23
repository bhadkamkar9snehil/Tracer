# Changelog

## Unreleased - 2026-05-23

### Fixed
- Hardened analyzer run reconstruction to avoid nested SQLite transaction failures by using a safe savepoint/transaction pattern.
- Prevented unavailable expected paths from being recorded or displayed as perfect run-delta scores.
- Restored incomplete-run fallback diagnostics when the actual_runs table exists but has no reconstructed runs.
- Ensured selected-run playback compares the full selected run instead of using the UI row limit.
- Reduced false unexpected rows from duplicate/retry trace events with the same SrNo/SubSeqNo.

### Changed
- Centralized analyzer expected-vs-actual comparison behavior so playback and saved run deltas remain consistent.
- Made run-delta score storage compatible with both nullable and NOT NULL score schemas.

### Validation
- Ran Python compile checks.
- Ran SQLite smoke tests for expected-path unavailable, duplicate actual rows, empty actual_runs fallback, selected-run playback, and transaction-safe reconstruction.

### Notes
- Browser-heavy testing was intentionally skipped; UI verification remains manual.
