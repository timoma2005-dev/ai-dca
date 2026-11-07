from datetime import date
from pathlib import Path
import tempfile
import unittest

from four_etf_signal.calendar import previous_day, sessions
from four_etf_signal.history import archive, calculate_normal, completed_labels, initial_normal, load_normal
from four_etf_signal.rules import CODES, INITIAL_NORMALS, DataUnavailable


class QuarterlyTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.db = archive(":memory:")
        days = sessions(date(2026, 1, 1), date(2026, 12, 31))
        for c in CODES:
            cls.db.executemany("INSERT INTO bars VALUES(?,?,?,?,?)", [
                (c, ts, 1.05, 100 if index else 0, "fixture")
                for day in days for index, ts in enumerate(sorted(completed_labels(day)))])
            cls.db.executemany("INSERT OR REPLACE INTO nav VALUES(?,?,?,?)", [
                (c, previous_day(day).isoformat(), 1.0, "fixture") for day in days])
        cls.db.commit()

    @classmethod
    def tearDownClass(cls):
        cls.db.close()

    def setUp(self):
        self.db.execute("SAVEPOINT testcase")

    def tearDown(self):
        self.db.execute("ROLLBACK TO testcase")
        self.db.execute("RELEASE testcase")

    def test_trailing_year_positive_minute_median_excludes_future(self):
        self.db.execute("INSERT INTO bars VALUES('159696','202701010931',500,100,'future')")
        record = calculate_normal(self.db, date(2027, 1, 1))
        self.assertEqual(record["fit_start"], "2026-01-01")
        self.assertEqual(record["fit_end"], "2026-12-31")
        self.assertEqual(record["next_recalculation"], "2027-04-01")
        for c in CODES:
            self.assertAlmostEqual(record["normal_pp"][c], 5.0)
            self.assertEqual(record["positive_minutes"][c], record["trading_days"] * 239)

    def test_missing_minute_or_nav_prevents_recalculation(self):
        self.db.execute("DELETE FROM bars WHERE code='159696' AND ts='202601050931'")
        with self.assertRaisesRegex(DataUnavailable, "incomplete_training_minutes"):
            calculate_normal(self.db, date(2027, 1, 1))

    def test_missing_t1_cannot_be_replaced_by_t2(self):
        self.db.execute("DELETE FROM nav WHERE code='159941' AND date='2025-12-31'")
        with self.assertRaisesRegex(DataUnavailable, "missing_training_t1_nav"):
            calculate_normal(self.db, date(2027, 1, 1))

    def test_brief_initials_and_expiry(self):
        with tempfile.TemporaryDirectory() as tmp:
            initial_normal(tmp)
            record = load_normal(tmp, date(2026, 11, 9))
            self.assertEqual(record["normal_pp"], INITIAL_NORMALS)
            with self.assertRaisesRegex(DataUnavailable, "expired"):
                load_normal(tmp, date(2027, 1, 1))


if __name__ == "__main__":
    unittest.main()
