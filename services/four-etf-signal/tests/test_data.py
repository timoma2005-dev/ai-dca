from datetime import date, datetime, timedelta
import unittest

from four_etf_signal.calendar import previous_day, trading_day
from four_etf_signal.data import TZ, nav_rows, parse_minutes, preopen_nav, quote_eligibility, validate_nav
from four_etf_signal.rules import CODES, DataUnavailable, digest


class DataTest(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 11, 9, 9, 20, 0, tzinfo=TZ)
        self.histories = {c: {"2026-11-06": 1.0} for c in CODES}

    def test_preopen_exact_t1_weekend_alignment(self):
        record = preopen_nav(self.now.date(), self.now, self.histories)
        self.assertEqual(record["nav_date"], "2026-11-06")
        self.assertEqual(validate_nav(record, self.now.date()), dict.fromkeys(CODES, 1.0))
        self.assertEqual(previous_day(date(2026, 10, 8)), date(2026, 9, 30))

    def test_old_nav_and_late_arrival_fail_closed(self):
        for now in (self.now.replace(hour=9, minute=30), self.now.replace(hour=10)):
            with self.assertRaisesRegex(DataUnavailable, "before_open"):
                preopen_nav(now.date(), now, self.histories)
        self.histories["159941"] = {"2026-11-05": 1.0}
        with self.assertRaisesRegex(DataUnavailable, "missing_t1"):
            preopen_nav(self.now.date(), self.now, self.histories)

    def test_record_tamper_source_and_date_rejected(self):
        original = preopen_nav(self.now.date(), self.now, self.histories)
        for patch in ({"source": "pcf"}, {"nav_date": "2026-11-05"}, {"ready_at": "2026-11-09T09:30:00+08:00"}):
            record = {**original, **patch}
            record["sha256"] = digest({k: v for k, v in record.items() if k != "sha256"})
            with self.assertRaises(DataUnavailable):
                validate_nav(record, self.now.date())
        record = {**original, "nav": {**original["nav"], "159696": 99}}
        with self.assertRaises(DataUnavailable):
            validate_nav(record, self.now.date())

    def test_weekend_holiday_and_unknown_year(self):
        self.assertFalse(trading_day(date(2026, 11, 8)))
        self.assertFalse(trading_day(date(2026, 10, 1)))
        with self.assertRaisesRegex(DataUnavailable, "calendar_year"):
            trading_day(date(2027, 1, 4))

    def test_nav_provider_errors_and_duplicate_dates(self):
        payload = {"ErrCode": 0, "Data": {"LSJZList": [{"FSRQ": "2026-11-06", "DWJZ": "1.6589"}]}}
        self.assertEqual(nav_rows(payload), {"2026-11-06": 1.6589})
        for bad in ({"ErrCode": 0, "Data": None}, {"ErrCode": 1}, {"ErrCode": 0, "Data": {"LSJZList": []}}):
            with self.assertRaises(DataUnavailable):
                nav_rows(bad)
        payload["Data"]["LSJZList"] *= 2
        with self.assertRaises(DataUnavailable):
            nav_rows(payload)

    def test_snapshot_and_symbol_timestamp_both_checked(self):
        payload = {"generated_at": self.now.isoformat(), "symbols": [
            {"symbol": c, "price_timestamp": self.now.isoformat(), "price": 1.0, "volume": 100} for c in CODES]}
        flags, _ = quote_eligibility(payload, self.now)
        self.assertTrue(all(not v["stale"] for v in flags.values()))
        payload["symbols"][1]["price_timestamp"] = (self.now - timedelta(seconds=46)).isoformat()
        flags, _ = quote_eligibility(payload, self.now)
        self.assertTrue(flags["159696"]["stale"])
        payload["generated_at"] = (self.now - timedelta(seconds=46)).isoformat()
        with self.assertRaisesRegex(DataUnavailable, "stale_collector"):
            quote_eligibility(payload, self.now)

    def test_complete_minute_only_and_lot_conversion(self):
        payload = {"code": 0, "data": {"sz159696": {"m1": [
            ["202611090930", "1", "1", "1", "1", "10"],
            ["202611090931", "1", "1.001", "1.001", "1", "2"],
            ["202611090932", "1", "99", "99", "1", "30"]]}}}
        out = parse_minutes("159696", payload, "202611090931")
        self.assertEqual(out["202611090931"], {"close": 1.001, "volume": 200})
        self.assertNotIn("202611090932", out)
        payload["data"]["sz159696"]["m1"].append(payload["data"]["sz159696"]["m1"][1])
        with self.assertRaises(DataUnavailable):
            parse_minutes("159696", payload, "202611090931")


if __name__ == "__main__":
    unittest.main()
