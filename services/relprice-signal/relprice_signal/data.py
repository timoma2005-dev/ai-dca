"""Read-only minute history, no-proxy collector and completed Tencent bars."""
from __future__ import annotations

import concurrent.futures
from datetime import datetime, timedelta
import hashlib
import json
import math
from pathlib import Path
import sqlite3
import sys
import urllib.request
from zoneinfo import ZoneInfo

from .rules import CODES, DataUnavailable, positive

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "market-collector"))
from market_collector.calendar_cn import HOLIDAY_RANGES, is_trading_day  # noqa: E402

TZ = ZoneInfo("Asia/Shanghai")


def exchange_code(code):
    return ("sh" if code.startswith("5") else "sz") + code


def trading_day(day):
    if str(day.year) not in HOLIDAY_RANGES:
        raise DataUnavailable("unconfigured_calendar_year")
    return is_trading_day(datetime.combine(day, datetime.min.time(), TZ))


def prior_days(day, count=30):
    result = []
    while len(result) < count:
        day -= timedelta(days=1)
        if trading_day(day):
            result.append(day.strftime("%Y%m%d"))
    return list(reversed(result))


def timestamp(value):
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            raise ValueError("timezone required")
        return parsed.astimezone(TZ)
    except (ValueError, TypeError):
        raise DataUnavailable("invalid_source_timestamp") from None


def validate_latest(payload, now, max_age=45):
    gen = timestamp(payload.get("generated_at"))
    age = (now - gen).total_seconds()
    if gen.date() != now.date() or not -2 <= age <= max_age:
        raise DataUnavailable("stale_collector_snapshot")
    rows = {str(r.get("symbol")): r for r in payload.get("symbols", [])}
    ages = {}
    for code in CODES:
        row = rows.get(code, {})
        source = timestamp(row.get("price_timestamp"))
        ages[code] = (now - source).total_seconds()
        if source.date() != now.date() or not -2 <= ages[code] <= max_age:
            raise DataUnavailable("stale_symbol:" + code)
        if row.get("suspended") or not positive(row.get("price")) or not positive(row.get("volume")):
            raise DataUnavailable("suspended_or_invalid_symbol:" + code)
        if row.get("quality", {}).get("status") not in (None, "ok"):
            raise DataUnavailable("bad_quote_quality:" + code)
    return {"snapshot_at": gen.isoformat(), "snapshot_age_sec": age, "symbol_age_sec": ages}


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def history_from_db(path, days):
    """Match marks.ffill() at 14:40, including a previous valid day if needed.

    Require every expected trading day to exist. An absent day never silently
    lengthens the 30-day window. The source DB is always opened read-only.
    """
    prices = {d: {} for d in days}
    validity = {d: {} for d in days}
    with sqlite3.connect(Path(path).resolve().as_uri() + "?mode=ro", uri=True, timeout=10) as db:
        for code in CODES:
            full = exchange_code(code)
            rows = db.execute(
                "SELECT ts,open,close,vol FROM k1 WHERE code=? AND ts>=? AND ts<=? ORDER BY ts",
                (full, days[0] + "0000", days[-1] + "1440")).fetchall()
            seed = db.execute(
                "SELECT close FROM k1 WHERE code=? AND ts<? AND open>0 AND close>0 AND vol>0 ORDER BY ts DESC LIMIT 1",
                (full, days[0] + "0000")).fetchone()
            mark = seed[0] if seed else None
            at = 0
            for day in days:
                seen = False
                valid_at_signal = False
                bound = day + "1440"
                while at < len(rows) and str(rows[at][0]) <= bound:
                    ts, op, close, vol = rows[at]
                    ok = positive(op) and positive(close) and positive(vol)
                    if ok:
                        mark = close
                    if str(ts)[:8] == day:
                        seen = True
                    if str(ts) == bound:
                        valid_at_signal = ok
                    at += 1
                if not seen or not positive(mark):
                    raise DataUnavailable("missing_history_session:" + day + ":" + code)
                prices[day][code] = mark
                validity[day][code] = valid_at_signal
    return prices, validity


def tick_snapshot_payload(path):
    """Collector's ~3.5 s tick-snapshot.json in /latest shape (one capture time for every symbol)."""
    with open(path, encoding="utf-8") as f:
        raw = json.load(f)
    captured = raw.get("captured_at")
    symbols = raw.get("symbols") if isinstance(raw.get("symbols"), dict) else {}
    return {"generated_at": captured, "source": "tick_snapshot", "symbols": [
        {"symbol": c, "price": (symbols.get(c) or {}).get("price"), "volume": (symbols.get(c) or {}).get("volume"),
         "suspended": (symbols.get(c) or {}).get("suspended", c not in symbols), "price_timestamp": captured}
        for c in CODES]}


class LiveMarket:
    def __init__(self, latest_url="http://127.0.0.1:18080/latest", minute_base="https://ifzq.gtimg.cn/appstock/app/kline/mkline",
                 snapshot_path=None, max_age=45, clock=None):
        self.latest_url = latest_url
        self.minute_base = minute_base
        self.snapshot_path, self.max_age = snapshot_path, max_age
        self.clock = clock or (lambda: datetime.now(TZ))

    @staticmethod
    def get_json(url):
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(url, timeout=8) as response:
            return json.loads(response.read(2_000_000))

    def latest(self):
        # /latest refreshes about every 60 s and its per-symbol stamps drift past 45 s
        # (2026-11-09 14:40 skipped on stale_symbol:513100). Prefer the tick snapshot when it
        # validates; otherwise fall back to /latest and let validate_latest decide.
        if self.snapshot_path:
            try:
                payload = tick_snapshot_payload(self.snapshot_path)
                validate_latest(payload, self.clock(), self.max_age)
                return payload
            except (DataUnavailable, OSError, ValueError):
                pass
        return self.get_json(self.latest_url)

    def minute(self, code, day, now):
        full = exchange_code(code)
        payload = self.get_json(self.minute_base + "?param=" + full + ",m1,,320")
        if payload.get("code") != 0:
            raise DataUnavailable("minute_provider_error:" + code)
        rows = payload.get("data", {}).get(full, {}).get("m1", [])
        output = []
        seen = set()
        current_label = now.strftime("%Y%m%d%H%M")
        for row in rows:
            if not isinstance(row, list) or len(row) < 6:
                raise DataUnavailable("invalid_minute_shape:" + code)
            label = str(row[0])
            if len(label) != 12 or not label.isdigit():
                raise DataUnavailable("invalid_minute_shape:" + code)
            if label in seen:
                raise DataUnavailable("duplicate_minute:" + code)
            seen.add(label)
            # A right-labelled minute is eligible only after its endpoint.
            # A small completion lag is imposed by runner before reading.
            if label[:8] == day and label <= current_label:
                numeric = [float(x) for x in row[1:6]]
                if not all(math.isfinite(x) for x in numeric) or numeric[-1] < 0:
                    raise DataUnavailable("nonfinite_minute:" + code)
                output.append([label, *numeric])
        if not output:
            raise DataUnavailable("missing_current_minutes:" + code)
        return output

    def bars(self, codes, day, now):
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
            jobs = {c: pool.submit(self.minute, c, day, now) for c in codes}
            return {c: job.result() for c, job in jobs.items()}


def signal_prices(bars, day):
    prices, valid = {}, {}
    for c in CODES:
        eligible = [r for r in bars.get(c, []) if r[0] <= day + "1440"]
        marks = [r for r in eligible if positive(float(r[1])) and positive(float(r[2])) and positive(float(r[5]))]
        exact = next((r for r in eligible if r[0] == day + "1440"), None)
        # Never forward-fill today's unavailable 14:40 signal qualification.
        if not marks or exact is None:
            raise DataUnavailable("missing_1440_minute:" + c)
        prices[c] = float(marks[-1][2])
        valid[c] = positive(float(exact[1])) and positive(float(exact[2])) and positive(float(exact[5]))
    return prices, valid
