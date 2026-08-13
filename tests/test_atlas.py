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

    def _add_run(
        self,
        run_id: str,
        started: datetime,
        steps: list[tuple[int, str, int]],
        status: str = "complete",
        sr_no: int = 1,
    ) -> None:
        event_ids = []
        for sequence, label, offset_ms in steps:
            event_id = f"{run_id}-{sequence}"
            event_ids.append(event_id)
            event_time = started + timedelta(milliseconds=offset_ms)
            self.conn.execute(
                """INSERT INTO trace_events
                   (id, report_date, entry_datetime, name, type, step, sr_no, sub_seq_no, execution_query, details)
                   VALUES (?, ?, ?, 'Procedure_A', 'Production', ?, ?, ?, '', '{}')""",
                (event_id, started.date().isoformat(), event_time.isoformat(), label, sr_no, sequence),
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

    def test_complete_sequence_family_is_not_compared_to_another_family(self) -> None:
        base = datetime(2026, 1, 3, tzinfo=timezone.utc)
        for index in range(4):
            self._add_run(
                f"branch-six-{index}",
                base + timedelta(minutes=index),
                [(1, "Entered", 0), (2, "Branch six work", 10), (3, "Completed", 20)],
                sr_no=6,
            )

        payload = atlas.atlas_payload(self.conn, {"signal": "all", "limit": "50"})
        branch = next(run for run in payload["runs"] if run["run_id"] == "branch-six-0")

        self.assertEqual(branch["deviation_score"], 0)
        self.assertEqual(branch["missing"], [])
        self.assertEqual(branch["unexpected"], [])
        self.assertEqual(branch["sequence_family"], ["6:1", "6:2", "6:3"])

    def test_incomplete_run_uses_the_closest_complete_sequence_family(self) -> None:
        base = datetime(2026, 1, 4, tzinfo=timezone.utc)
        for index in range(3):
            self._add_run(
                f"branch-six-complete-{index}",
                base + timedelta(minutes=index),
                [(1, "Entered", 0), (2, "Branch six work", 10), (3, "Completed", 20)],
                sr_no=6,
            )
        self._add_run(
            "branch-six-incomplete",
            base + timedelta(minutes=10),
            [(1, "Entered", 0), (2, "Branch six work", 10)],
            status="incomplete",
            sr_no=6,
        )

        payload = atlas.atlas_payload(self.conn, {"signal": "all", "limit": "50"})
        branch = next(run for run in payload["runs"] if run["run_id"] == "branch-six-incomplete")

        self.assertEqual(branch["sequence_family"], ["6:1", "6:2", "6:3"])
        self.assertEqual(branch["missing"], ["6:3"])
        self.assertEqual(branch["unexpected"], [])

    def test_atlas_identifies_explainable_deviation(self) -> None:
        payload = atlas.atlas_payload(self.conn, {"limit": "50"})
        self.assertEqual(payload["summary"]["executions"], 13)
        problem = next(run for run in payload["runs"] if run["run_id"] == "problem-run")
        self.assertGreaterEqual(problem["deviation_score"], 60)
        self.assertIn("error", problem["primary_reason"].lower())
        self.assertGreaterEqual(payload["summary"]["deviated"], 1)
        self.assertEqual(payload["result"]["signal"], "deviated")
        self.assertEqual(payload["result"]["total_matching"], 1)
        self.assertEqual(payload["inbox"][0]["run_id"], "problem-run")
        self.assertNotIn("reason", payload["inbox"][0])
        self.assertEqual(payload["inbox"][0]["signals"][0]["label"], "Error")

    def test_kpi_signal_filters_the_coordinated_run_scope(self) -> None:
        all_runs = atlas.atlas_payload(self.conn, {"signal": "all", "limit": "50"})
        failed_runs = atlas.atlas_payload(self.conn, {"signal": "failed", "limit": "50"})
        self.assertEqual(all_runs["result"]["total_matching"], 13)
        self.assertEqual(failed_runs["result"]["total_matching"], 1)
        self.assertEqual(failed_runs["runs"][0]["run_id"], "problem-run")

    def test_sequence_variant_filters_runs_with_the_exact_path(self) -> None:
        variant_id = atlas._variant_id(["1:1", "1:4", "1:5"])
        payload = atlas.atlas_payload(
            self.conn,
            {"signal": "all", "variant": variant_id, "limit": "50"},
        )
        self.assertEqual(payload["result"]["total_matching"], 1)
        self.assertEqual(payload["runs"][0]["run_id"], "problem-run")
        self.assertTrue(any(item["id"] == variant_id for item in payload["variants"]))

    def test_focused_inbox_run_is_forced_into_the_matrix_window(self) -> None:
        base = datetime(2026, 1, 2, tzinfo=timezone.utc)
        for index in range(15):
            self._add_run(
                f"additional-{index}",
                base + timedelta(minutes=index),
                [(1, "Entered", 0), (2, "Validate", 10), (3, "Completed", 20)],
            )
        payload = atlas.atlas_payload(
            self.conn,
            {"signal": "all", "sort": "duration", "limit": "20", "run": "normal-0"},
        )
        self.assertEqual(payload["result"]["shown"], 20)
        self.assertTrue(payload["result"]["focused_run_included"])
        self.assertIn("normal-0", {run["run_id"] for run in payload["runs"]})

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

    def test_date_only_end_includes_the_entire_selected_day(self) -> None:
        payload = atlas.atlas_payload(
            self.conn,
            {"start": "2026-01-01", "end": "2026-01-01", "limit": "50"},
        )
        self.assertEqual(payload["summary"]["executions"], 13)

    def test_date_range_excludes_runs_outside_the_selected_days(self) -> None:
        payload = atlas.atlas_payload(
            self.conn,
            {"start": "2026-01-02", "end": "2026-01-02", "limit": "50"},
        )
        self.assertEqual(payload["summary"]["executions"], 0)

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
