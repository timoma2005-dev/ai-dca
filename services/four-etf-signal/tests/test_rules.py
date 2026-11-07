from copy import deepcopy
import unittest

from four_etf_signal.rules import CODES, DataUnavailable, advance, decide, deviations, next_minute


def bars(**values):
    result = {c: {"close": 1.01, "volume": 100} for c in CODES}
    for c, dev in values.items():
        result[c]["close"] = 1 + dev / 100
    return result


NAV = dict.fromkeys(CODES, 1.0)
NORMAL = dict.fromkeys(CODES, 0.0)


def initial(holding="159696"):
    return {"holding": holding, "pending": None, "last_minute": "", "revision": 0}


class RulesTest(unittest.TestCase):
    def test_formula_uses_nav_not_iopv(self):
        b = bars(**{"159696": 8})
        b["159696"]["iopv"] = 900
        normal = {**NORMAL, "159696": 3.0}
        values, _ = deviations(b, NAV, normal)
        self.assertAlmostEqual(values["159696"], 5)

    def test_strict_threshold(self):
        for gap, outcome in [(0.49999, "hold"), (0.5, "hold"), (0.50001, "signal")]:
            b = bars(**{"159696": 1 + gap, "159941": 1})
            self.assertEqual(decide("159696", b, NAV, NORMAL)["decision"], outcome)

    def test_exclude_suspended_or_zero_target(self):
        for flag in ({"volume": 0}, {"suspended": True}, {"stale": True}):
            b = bars(**{"159696": 2, "159941": -3, "159501": 0})
            b["159941"].update(flag)
            self.assertEqual(decide("159696", b, NAV, NORMAL)["target"], "159501")

    def test_held_suspension_waits(self):
        for flag in ({"volume": 0}, {"suspended": True}, {"stale": True}):
            b = bars(**{"159696": 3, "159941": 0})
            b["159696"].update(flag)
            self.assertEqual(decide("159696", b, NAV, NORMAL)["decision"], "wait")

    def test_nav_missing_nan_or_stale_inputs_do_not_signal(self):
        for nav in ({}, {**NAV, "159941": None}, {**NAV, "513100": float("nan")}):
            state = initial()
            with self.assertRaises(DataUnavailable):
                advance(state, "202611091000", bars(), nav, NORMAL)
            self.assertEqual(state, initial())

    def test_next_minute_confirmation_and_no_trigger_push(self):
        b = bars(**{"159696": 2, "159941": 0})
        state, row = advance(initial(), "202611091000", b, NAV, NORMAL)
        self.assertIsNone(row["confirmed"])
        self.assertEqual(state["holding"], "159696")
        state, row = advance(state, "202611091001", b, NAV, NORMAL)
        self.assertEqual(row["confirmed"]["target"], "159941")
        self.assertEqual(row["confirmed"]["event_id"], "fourETF:2026-11-09:1000")
        self.assertEqual(state["holding"], "159941")
        self.assertEqual(state["revision"], 1)
        self.assertFalse(state["actual_holding_confirmed"])

    def test_target_stays_locked_even_when_ranking_changes(self):
        b = bars(**{"159696": 2, "159941": 0})
        state, _ = advance(initial(), "202611091000", b, NAV, NORMAL)
        b["159501"]["close"] = 0.99
        state, row = advance(state, "202611091001", b, NAV, NORMAL)
        self.assertEqual(row["confirmed"]["target"], "159941")
        self.assertEqual(state["holding"], "159941")

    def test_no_recheck_of_gap_at_fill(self):
        b = bars(**{"159696": 2, "159941": 0})
        state, _ = advance(initial(), "202611091000", b, NAV, NORMAL)
        b["159696"]["close"] = 1.0
        state, row = advance(state, "202611091001", b, NAV, NORMAL)
        self.assertIsNotNone(row["confirmed"])
        self.assertEqual(state["holding"], "159941")

    def test_untradeable_confirmation_is_cancelled(self):
        for c in ("159696", "159941"):
            b = bars(**{"159696": 2, "159941": 0})
            state, _ = advance(initial(), "202611091000", b, NAV, NORMAL)
            b[c]["volume"] = 0
            state, row = advance(state, "202611091001", b, NAV, NORMAL)
            self.assertIsNone(row["confirmed"])
            self.assertEqual(row["cancelled"], "confirmation_untradeable")
            self.assertEqual(state["holding"], "159696")

    def test_missing_exact_confirmation_not_filled_later(self):
        b = bars(**{"159696": 2, "159941": 0})
        state, _ = advance(initial(), "202611091000", b, NAV, NORMAL)
        state, row = advance(state, "202611091002", b, NAV, NORMAL)
        self.assertIsNone(row["confirmed"])
        self.assertEqual(row["cancelled"], "missed_confirmation_minute")
        self.assertEqual(state["holding"], "159696")

    def test_close_signal_never_pushes_or_carries(self):
        b = bars(**{"159696": 2, "159941": 0})
        state, row = advance(initial(), "202611091500", b, NAV, NORMAL)
        self.assertEqual(row["decision"], "close_signal_cancelled")
        self.assertEqual(row["target"], "159941")
        self.assertIsNone(row["confirmed"])
        self.assertIsNone(state["pending"])
        self.assertEqual(state["holding"], "159696")

    def test_lunch_next_completed_minute(self):
        self.assertEqual(next_minute("202611091130"), "202611091301")
        b = bars(**{"159696": 2, "159941": 0})
        state, _ = advance(initial(), "202611091130", b, NAV, NORMAL)
        state, row = advance(state, "202611091300", {}, NAV, NORMAL)
        self.assertEqual(row["decision"], "pending")
        state, row = advance(state, "202611091301", b, NAV, NORMAL)
        self.assertIsNotNone(row["confirmed"])

    def test_duplicates_and_day_rollover_never_confirm_old_signal(self):
        b = bars(**{"159696": 2, "159941": 0})
        state, _ = advance(initial(), "202611091000", b, NAV, NORMAL)
        copy = deepcopy(state)
        state, row = advance(state, "202611091000", b, NAV, NORMAL)
        self.assertEqual(state, copy)
        self.assertEqual(row["reason"], "minute_already_processed")
        state, row = advance(state, "202611100931", b, NAV, NORMAL)
        self.assertIsNone(row["confirmed"])
        self.assertEqual(state["holding"], "159696")

    def test_tie_break_is_code_order(self):
        b = bars(**{"159696": 2, "513100": 0, "159501": 0, "159941": 0})
        self.assertEqual(decide("159696", b, NAV, NORMAL)["target"], "159501")


if __name__ == "__main__":
    unittest.main()
