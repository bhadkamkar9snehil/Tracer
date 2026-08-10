from __future__ import annotations

import sqlite3
import unittest
from datetime import datetime, timedelta, timezone

from tracer import atlas, cache


class AtlasTests(unittest.TestCase):
    def setUp(self) -> None:
        self.conn = sqlite3.connect(":memory:")
        self.conn.row_factory = sqlite3.Row
        cache.init_db(self.conn)
        base = datetime(2026, 1, 1, tzinfo=timezone.utc)
        for index in range(12):
            self._add_run(
                f"normal-{index}",
                base + timedelta(minutes=index),
                [(1, "Entered", 0), (2, "Validate", 10), (3, "Completed", 20)],
            )
        self._add_run(
            "problem-run",
            base + timedelta(minutes=20),
            [(1, "Entered", 0), (4, "Unexpected retry", 900), (5, "Error", 905)],
            status="error",
        )

    def tearDown(self) -> None:
        self.conn.close()

    def _add_run(self, run_id: str, started: datetime, steps: list[tuple[int, str, int]], status: str = "complete") -> None:
        event_ids = []
        for sequence, label, offset_ms in steps:
            event_id = f"{run_id}-{sequence}"
            event_ids.append(event_id)
            event_time = started + timedelta(milliseconds=offset_ms)
            self.conn.execute(
                """INSERT INTO trace_events
                   (id, report_date, entry_datetime, name, type, step, sr_no, sub_seq_no, execution_query, details)
                   VALUES (?, ?, ?, 'Procedure_A', 'Production', ?, 1, ?, '', '{}')""",
                (event_id, started.date().isoformat(), event_time.isoformat(), label, sequence),
            )
        duration = steps[-1][2] if steps else 0
        self.conn.execute(
            """INSERT INTO actual_runs
               (run_id, name, type, execution_query_hash, parameter_signature, start_time, end_time,
                duration_ms, status, event_count, error_count)
               VALUES (?, 'Procedure_A', 'Production', '', '', ?, ?, ?, ?, ?, ?)""",
            (
                run_id,
                started.isoformat(),
                (started + timedelta(milliseconds=duration)).isoformat(),
                duration,
                status,
                len(steps),
                int(status == "error"),
            ),
        )
        self.conn.executemany(
            "INSERT INTO actual_run_events(run_id, event_id) VALUES (?, ?)",
            [(run_id, event_id) for event_id in event_ids],
        )
        self.conn.commit()

    def test_atlas_identifies_explainable_deviation(self) -> None:
        payload = atlas.atlas_payload(self.conn, {"limit": "50"})
        self.assertEqual(payload["summary"]["executions"], 13)
        problem = next(run for run in payload["runs"] if run["run_id"] == "problem-run")
        self.assertGreaterEqual(problem["deviation_score"], 60)
        self.assertIn("error", problem["primary_reason"].lower())
        self.assertGreaterEqual(payload["summary"]["deviated"], 1)

    def test_run_detail_compares_expected_and_actual(self) -> None:
        payload = atlas.run_payload(self.conn, "problem-run")
        self.assertIsNotNone(payload)
        run = payload["run"]
        kinds = {item["kind"] for item in run["explanations"]}
        self.assertIn("error", kinds)
        self.assertIn("missing", kinds)
        self.assertIn("unexpected", kinds)
        states = {item["state"] for item in run["waterfall"]}
        self.assertIn("missing", states)
        self.assertIn("unexpected", states)

    def test_filters_are_applied_before_analysis(self) -> None:
        payload = atlas.atlas_payload(self.conn, {"status": "error", "limit": "50"})
        self.assertEqual(payload["summary"]["executions"], 1)
        self.assertEqual(payload["runs"][0]["run_id"], "problem-run")

    def test_filter_options_include_procedure_type_cohorts(self) -> None:
        payload = atlas.atlas_payload(self.conn, {"limit": "50"})
        self.assertEqual(
            payload["filters"]["cohorts"],
            [{"name": "Procedure_A", "type": "Production", "count": 13}],
        )

    def test_missing_run_returns_none(self) -> None:
        self.assertIsNone(atlas.run_payload(self.conn, "does-not-exist"))

    def test_empty_cache_returns_a_complete_empty_contract(self) -> None:
        empty = sqlite3.connect(":memory:")
        empty.row_factory = sqlite3.Row
        cache.init_db(empty)
        payload = atlas.atlas_payload(empty)
        self.assertEqual(payload["summary"]["executions"], 0)
        self.assertEqual(payload["runs"], [])
        self.assertEqual(payload["freshness"]["state"], "empty")
        empty.close()

    def test_percentile_is_interpolated(self) -> None:
        self.assertEqual(atlas._percentile([0, 10, 20], 0.5), 10)
        self.assertEqual(atlas._percentile([], 0.95), 0)


if __name__ == "__main__":
    unittest.main()
