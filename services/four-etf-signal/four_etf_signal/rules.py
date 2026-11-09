"""Pure minute state machine; values and thresholds are percentage points."""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timedelta
import hashlib
import json
import math

CODES = ("513100", "159696", "159501", "159941")
# T-2 NAV medians, fit 2025-11-07..2026-11-06 (T-1 version was 7.7054/6.7413/7.2303/6.7483).
INITIAL_NORMALS = dict(zip(CODES, (7.5228, 6.547, 7.1734, 6.599)))
THRESHOLD_PP = 0.5


class DataUnavailable(ValueError):
    pass


def positive(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value > 0


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def is_minute(hm):
    return "0930" <= hm <= "1130" or "1300" <= hm <= "1500"


def next_minute(label):
    hm = label[-4:]
    if hm == "1500":
        return None
    if hm == "1130":
        return label[:8] + "1301"  # right-labelled completed bar after lunch
    if not is_minute(hm):
        raise DataUnavailable("outside_session")
    return (datetime.strptime(label, "%Y%m%d%H%M") + timedelta(minutes=1)).strftime("%Y%m%d%H%M")


def deviations(bars, nav, normal):
    """NAV(T-2) completeness is mandatory even when an ETF is suspended."""
    if set(nav) != set(CODES) or any(not positive(nav[c]) for c in CODES):
        raise DataUnavailable("missing_or_invalid_nav")
    if set(normal) != set(CODES) or any(not isinstance(normal[c], (float, int)) or not math.isfinite(normal[c]) for c in CODES):
        raise DataUnavailable("invalid_normal")
    values, eligible = {}, {}
    for c in CODES:
        bar = bars.get(c, {})
        close = bar.get("close")
        if positive(close):
            values[c] = 100 * (close / nav[c] - 1) - normal[c]
        eligible[c] = (c in values and positive(bar.get("volume"))
                       and not bar.get("suspended", False) and not bar.get("stale", False))
    return values, eligible


def decide(holding, bars, nav, normal):
    if holding not in CODES:
        raise DataUnavailable("invalid_holding")
    values, eligible = deviations(bars, nav, normal)
    base = {"holding": holding, "deviations_pp": values, "eligible": eligible,
            "threshold_pp": THRESHOLD_PP, "target": None, "gap_pp": None}
    if not eligible[holding]:
        return {**base, "decision": "wait", "reason": "holding_untradeable"}
    best = min((c for c in CODES if eligible[c]), key=lambda c: (values[c], c))
    gap = values[holding] - values[best]
    return {**base, "target": best, "gap_pp": gap,
            "decision": "signal" if best != holding and gap > THRESHOLD_PP + 1e-12 else "hold"}


def advance(state, label, bars, nav, normal):
    """Return a new state and audit result. A confirmation can also lock a new order.

    Missing the exact next bar cancels an order; it is never filled retrospectively.
    Confirmed rotations retain the original signal inputs, with execution prices
    attached from the new minute. Callers commit state before attempting email.
    """
    state = deepcopy(state)
    if not is_minute(label[-4:]):
        raise DataUnavailable("outside_session")
    if state.get("last_minute", "") >= label:
        return state, {"decision": "skip", "reason": "minute_already_processed", "confirmed": None}
    values, eligible = deviations(bars, nav, normal)
    state["last_minute"] = label
    confirmed, cancelled = None, None
    pending = state.get("pending")
    if pending:
        if pending["signal_minute"][:8] != label[:8] or label > pending["due_minute"]:
            cancelled = "missed_confirmation_minute"
            state["pending"] = None
        elif label == pending["due_minute"]:
            state["pending"] = None
            if pending["holding"] == state["holding"] and eligible[pending["holding"]] and eligible[pending["target"]]:
                confirmed = {**pending, "execution_minute": label,
                             "sell_close": bars[pending["holding"]]["close"],
                             "buy_close": bars[pending["target"]]["close"],
                             "sell_volume": bars[pending["holding"]]["volume"],
                             "buy_volume": bars[pending["target"]]["volume"]}
                state["holding"] = pending["target"]
                state["as_of"] = datetime.strptime(label, "%Y%m%d%H%M").date().isoformat()
                state["actual_holding_confirmed"] = False
                state["revision"] = state.get("revision", 0) + 1
            else:
                cancelled = "confirmation_untradeable"
        else:
            return state, {"decision": "pending", "pending": pending, "confirmed": None,
                           "deviations_pp": values, "eligible": eligible}
    result = decide(state["holding"], bars, nav, normal)
    if result["decision"] == "signal":
        due = next_minute(label)
        if due is None:
            result.update(decision="close_signal_cancelled", reason="no_next_minute_today")
        else:
            date = datetime.strptime(label, "%Y%m%d%H%M").date().isoformat()
            state["pending"] = {"holding": state["holding"], "target": result["target"],
                                "signal_minute": label, "due_minute": due,
                                "event_id": f"fourETF:{date}:{label[-4:]}",
                                "gap_pp": result["gap_pp"], "deviations_pp": result["deviations_pp"],
                                "eligible": result["eligible"],
                                "input_sha256": digest({"minute": label, "bars": bars, "nav": nav, "normal": normal})}
    return state, {**result, "confirmed": confirmed, "cancelled": cancelled}
