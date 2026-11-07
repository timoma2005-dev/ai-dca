"""Port of discovery/engine.py Features.get('rp', 30, 1440) / generate.

The exchange-prefixed order is the frozen backtest's sorted file order.
Prices in the trailing window are 14:40 marks, never daily closing prices.
"""
from __future__ import annotations

import math

CODES = ("513100", "513110", "513300", "513390", "513870", "159501",
         "159513", "159632", "159659", "159660", "159696", "159941")
LOOKBACK = 30
THRESHOLD = .006
EPSILON = 1e-14


class DataUnavailable(ValueError):
    """Fail closed: log the reason, never substitute a different signal."""


def positive(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value > 0


def relative(prices):
    if set(prices) != set(CODES) or not all(positive(prices[c]) for c in CODES):
        raise DataUnavailable("incomplete_price_cross_section")
    logs = [math.log(prices[c]) for c in CODES]
    center = sum(logs) / len(logs)
    return {c: logs[i] - center for i, c in enumerate(CODES)}


def scores(history, prices):
    if len(history) != LOOKBACK:
        raise DataUnavailable("need_exactly_30_prior_sessions")
    trailing = [relative(row) for row in history]
    current = relative(prices)
    return {c: current[c] - sum(row[c] for row in trailing) / LOOKBACK for c in CODES}


def decide(history, prices, valid, held):
    if held not in CODES:
        raise DataUnavailable("holding_outside_frozen_universe")
    values = scores(history, prices)
    if not valid.get(held, False):
        raise DataUnavailable("holding_no_positive_signal_bar")
    candidates = [c for c in CODES if c != held and valid.get(c, False)]
    if not candidates:
        raise DataUnavailable("no_eligible_alternative")
    target = min(candidates, key=lambda c: values[c])
    gap = values[held] - values[target]
    rotate = gap >= THRESHOLD - EPSILON
    return {"holding": held, "target": target, "next_holding": target if rotate else held,
            "gap_bp": gap * 10000, "decision": "rotate" if rotate else "hold", "scores": values}


def first_common_bar(bars, held, target, after="1440"):
    """Only completed bars of the frozen pair; never reselect the target."""
    by_code = {c: {str(r[0])[-4:]: r for r in bars.get(c, [])} for c in (held, target)}
    for hm in sorted(set(by_code[held]) & set(by_code[target])):
        if not after < hm <= "1500":
            continue
        rows = [by_code[c][hm] for c in (held, target)]
        if all(positive(float(r[1])) and positive(float(r[2])) and positive(float(r[5])) for r in rows):
            return {"time": hm, "sell_close": float(rows[0][2]), "buy_close": float(rows[1][2])}
    return None
