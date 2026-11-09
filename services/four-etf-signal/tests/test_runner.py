from argparse import Namespace
from datetime import datetime, timedelta
import json
from pathlib import Path
import tempfile
import unittest

from four_etf_signal.data import TZ, preopen_nav
from four_etf_signal.rules import CODES, INITIAL_NORMALS, DataUnavailable
from four_etf_signal.runner import OWNER, deliver_once, initialize, prepare_nav, run
from four_etf_signal.storage import atomic_json, read_json


class FakeMarket:
    def __init__(self, now, gap=1):
        self.now, self.gap = now, gap

    def collect(self, now):
        bars = {c: {"close": 1 + (INITIAL_NORMALS[c] + (self.gap if c == "159696" else 0)) / 100,
                    "volume": 100, "stale": False, "suspended": False} for c in CODES}
        return bars, {c: {now.strftime("%Y%m%d%H%M"): b} for c, b in bars.items()}, {
            "snapshot_age_sec": 0, "symbols": {c: {"age_sec": 0} for c in CODES}}


class RunnerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.directory = Path(self.tmp.name)
        self.config = {"initial_holding": "159696", "initial_as_of": "2026-11-06", "notification_mode": "enabled", "latest_url": "http://unused"}
        self.state = initialize(self.config, self.directory)
        self.now = datetime(2026, 11, 9, 10, 0, 8, tzinfo=TZ)
        self.args = Namespace(live=True)
        self.calls = []

    def tearDown(self):
        self.tmp.cleanup()

    def ready_nav(self):
        record = preopen_nav(self.now.date(), self.now.replace(hour=9, minute=0), {c: {"2026-11-05": 1.0} for c in CODES})
        atomic_json(self.directory / "nav-2026-11-09.json", record)

    def sender(self, config, payload):
        self.calls.append(payload)
        self.assertEqual(read_json(self.directory / "state.json")["holding"], payload["target"])
        self.assertEqual(len(list((self.directory / "events").glob("*.json"))), 1)
        return {"ok": True, "delivery_attempt": {"event_id": payload["event_id"], "status": "delivered", "channel": "email", "owner_user_id": OWNER}}

    def execute(self, now=None, state=None, sender=None, gap=1):
        now = now or self.now
        return run(self.config, self.args, self.directory, state or self.state, now,
                   market=FakeMarket(now, gap), sender=sender or self.sender, clock_now=lambda: now)

    def test_weekend_skip_no_market_or_push(self):
        out = self.execute(self.now.replace(day=8))
        self.assertEqual(out["reason"], "non_trading_day")
        self.assertFalse(self.calls)

    def test_missing_preopen_nav_prevents_any_signal(self):
        with self.assertRaisesRegex(DataUnavailable, "nav_not_ready"):
            self.execute()
        self.assertEqual(read_json(self.directory / "state.json"), self.state)
        self.assertFalse(self.calls)

    def test_live_state_before_send_and_duplicate_event_suppression(self):
        self.ready_nav()
        out = self.execute()
        self.assertEqual(out["decision"], "signal")
        self.assertFalse(self.calls)
        state = read_json(self.directory / "state.json")
        out = self.execute(self.now + timedelta(minutes=1), state)
        self.assertEqual(out["push"]["status"], "delivered")
        self.assertEqual(len(self.calls), 1)
        self.assertTrue((self.directory / "first-delivery.json").exists())
        latest = read_json(self.directory / "state.json")
        self.execute(self.now + timedelta(minutes=1), latest)
        again = deliver_once(self.directory, self.config, out["confirmed"], self.now, sender=self.sender)
        self.assertEqual(again["status"], "already_attempted")
        self.assertEqual(len(self.calls), 1)

    def test_network_failure_does_not_retry_or_undo_reference_holding(self):
        self.ready_nav()
        self.execute()
        state = read_json(self.directory / "state.json")
        def failed(config, payload):
            self.calls.append(payload)
            self.assertEqual(read_json(self.directory / "state.json")["holding"], payload["target"])
            raise DataUnavailable("notify_transport_unavailable")
        out = self.execute(self.now + timedelta(minutes=1), state, sender=failed)
        self.assertEqual(out["push"]["status"], "failed_or_unknown_no_retry")
        self.assertNotEqual(read_json(self.directory / "state.json")["holding"], "159696")
        deliver_once(self.directory, self.config, out["confirmed"], self.now, sender=failed)
        self.assertEqual(len(self.calls), 1)
        self.assertFalse((self.directory / "first-delivery.json").exists())

    def test_dry_run_does_not_consume_minute_or_change_state(self):
        self.ready_nav()
        before = (self.directory / "state.json").read_bytes()
        self.args.live = False
        self.execute()
        self.assertEqual((self.directory / "state.json").read_bytes(), before)
        self.assertFalse(self.calls)
        self.assertFalse((self.directory / "inputs").exists())

    def test_fetch_crossing_minute_fails_closed(self):
        self.ready_nav()
        with self.assertRaisesRegex(DataUnavailable, "expired_during_fetch"):
            run(self.config, self.args, self.directory, self.state, self.now, market=FakeMarket(self.now),
                sender=self.sender, clock_now=lambda: self.now + timedelta(minutes=1))
        self.assertFalse(self.calls)

    def test_nav_fetch_must_finish_before_open(self):
        start = self.now.replace(hour=9, minute=29, second=59)
        with self.assertRaisesRegex(DataUnavailable, "before_open"):
            prepare_nav(self.directory, start, fetcher=lambda c: {"2026-11-05": 1.0},
                        clock_now=lambda: start + timedelta(seconds=2))
        self.assertFalse((self.directory / "nav-2026-11-09.json").exists())


if __name__ == "__main__":
    unittest.main()
