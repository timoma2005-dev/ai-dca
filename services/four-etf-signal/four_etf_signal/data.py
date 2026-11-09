"""No-proxy CN data adapter; NAV unit values, never IOPV or PCF."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, time
import json
import math
from urllib.parse import urlencode
import urllib.request
from zoneinfo import ZoneInfo

from .calendar import nav_day
from .rules import CODES, DataUnavailable, digest, positive

TZ = ZoneInfo("Asia/Shanghai")
NAV_SOURCE = "eastmoney_f10_lsjz"


def timestamp(text):
    try:
        value = datetime.fromisoformat(str(text).replace("Z", "+00:00"))
        if value.tzinfo is None:
            raise ValueError()
        return value.astimezone(TZ)
    except (TypeError, ValueError):
        raise DataUnavailable("invalid_source_timestamp") from None


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise DataUnavailable("source_redirect_refused")


def get_json(url, *, headers=None):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    req = urllib.request.Request(url, headers=headers or {"User-Agent": "ai-dca-four-etf/1.0"})
    with opener.open(req, timeout=8) as r:
        body = r.read(2_000_001)
    if len(body) > 2_000_000:
        raise DataUnavailable("oversized_source_response")
    return json.loads(body)


def nav_rows(payload):
    if payload.get("ErrCode") != 0 or not isinstance(payload.get("Data"), dict):
        raise DataUnavailable("nav_provider_error")
    rows = payload["Data"].get("LSJZList")
    if not isinstance(rows, list) or not rows:
        raise DataUnavailable("nav_provider_empty")
    result = {}
    for row in rows:
        try:
            day = datetime.strptime(row["FSRQ"], "%Y-%m-%d").date().isoformat()
            value = float(row["DWJZ"])
        except (ValueError, KeyError, TypeError):
            raise DataUnavailable("invalid_nav_row") from None
        if not positive(value) or day in result:
            raise DataUnavailable("invalid_or_duplicate_nav")
        result[day] = value
    return result


def fetch_nav(code, fetch=get_json):
    return nav_rows(fetch("https://api.fund.eastmoney.com/f10/lsjz?" + urlencode({
        "fundCode": code, "pageIndex": 1, "pageSize": 10}), headers={
            "Referer": "https://fundf10.eastmoney.com/", "User-Agent": "Mozilla/5.0"}))


def preopen_nav(day, now, histories):
    cutoff = datetime.combine(day, time(9, 30), TZ)
    expected = nav_day(day).isoformat()
    if now.date() != day or now >= cutoff:
        raise DataUnavailable("nav_not_ready_before_open")
    values = {}
    for c in CODES:
        value = histories.get(c, {}).get(expected)
        if not positive(value):
            raise DataUnavailable("missing_t2_nav:" + c)
        values[c] = value
    record = {"date": day.isoformat(), "nav_date": expected, "source": NAV_SOURCE,
              "ready_at": now.isoformat(), "nav": values}
    record["sha256"] = digest(record)
    return record


def validate_nav(record, day):
    try:
        ready = timestamp(record.get("ready_at"))
        claimed = record.get("sha256")
        unsigned = {k: v for k, v in record.items() if k != "sha256"}
        if (record.get("source") != NAV_SOURCE or record.get("date") != day.isoformat()
                or record.get("nav_date") != nav_day(day).isoformat()
                or ready.date() != day or ready.time() >= time(9, 30)
                or claimed != digest(unsigned)
                or set(record.get("nav", {})) != set(CODES)
                or any(not positive(record["nav"][c]) for c in CODES)):
            raise DataUnavailable("invalid_preopen_nav")
    except (KeyError, TypeError):
        raise DataUnavailable("invalid_preopen_nav") from None
    return record["nav"]


def quote_eligibility(payload, now, max_age=45):
    generated = timestamp(payload.get("generated_at"))
    age = (now - generated).total_seconds()
    if generated.date() != now.date() or not -2 <= age <= max_age:
        raise DataUnavailable("stale_collector_snapshot")
    rows = {str(r.get("symbol")): r for r in payload.get("symbols", [])}
    fresh, audit = {}, {"snapshot_at": generated.isoformat(), "snapshot_age_sec": age, "symbols": {}}
    for c in CODES:
        row = rows.get(c, {})
        try:
            source = timestamp(row.get("price_timestamp"))
            delta = (now - source).total_seconds()
            stale = source.date() != now.date() or not -2 <= delta <= max_age
        except DataUnavailable:
            delta, stale = None, True
        fresh[c] = {"stale": stale, "suspended": row.get("suspended") is True
                    or not positive(row.get("price")) or not positive(row.get("volume"))}
        audit["symbols"][c] = {**fresh[c], "age_sec": delta}
    return fresh, audit


def parse_minutes(code, payload, label):
    full = ("sh" if code.startswith("5") else "sz") + code
    if payload.get("code") != 0:
        raise DataUnavailable("minute_provider_error:" + code)
    rows = payload.get("data", {}).get(full, {}).get("m1", [])
    output = {}
    for row in rows:
        if not isinstance(row, list) or len(row) < 6:
            raise DataUnavailable("invalid_minute_shape:" + code)
        key = str(row[0])
        try:
            datetime.strptime(key, "%Y%m%d%H%M")
            op, close, high, low, volume = map(float, row[1:6])
        except (TypeError, ValueError):
            raise DataUnavailable("invalid_minute_shape:" + code) from None
        if len(key) != 12 or key in output or not all(math.isfinite(x) for x in (op, close, high, low, volume)) or volume < 0:
            raise DataUnavailable("invalid_minute_value:" + code)
        if key[:8] == label[:8] and key <= label:
            output[key] = {"close": close, "volume": volume * 100}  # Tencent lots -> fund shares
    return output


def tick_snapshot_payload(path):
    """Collector's ~3.5 s tick-snapshot.json in /latest shape (one capture time for every symbol)."""
    with open(path, encoding="utf-8") as f:
        raw = json.load(f)
    captured = raw.get("captured_at")
    symbols = raw.get("symbols") if isinstance(raw.get("symbols"), dict) else {}
    return {"generated_at": captured, "symbols": [
        {"symbol": c, "price": (symbols.get(c) or {}).get("price"), "volume": (symbols.get(c) or {}).get("volume"),
         "suspended": (symbols.get(c) or {}).get("suspended"), "price_timestamp": captured} for c in CODES]}


class LiveMarket:
    def __init__(self, latest_url="http://127.0.0.1:18080/latest", fetch=get_json, snapshot_path=None):
        self.latest_url, self.fetch, self.snapshot_path = latest_url, fetch, snapshot_path

    def eligibility(self, now):
        # /latest only refreshes about every 60 s, which drifted past the 45 s limit for ~5 of every
        # ~13 minutes (2026-11-09). Prefer the high-frequency tick snapshot; fall back to /latest.
        if self.snapshot_path:
            try:
                flags, freshness = quote_eligibility(tick_snapshot_payload(self.snapshot_path), now)
                freshness["source"] = "tick_snapshot"
                return flags, freshness
            except (DataUnavailable, OSError, ValueError):
                pass
        flags, freshness = quote_eligibility(self.fetch(self.latest_url), now)
        freshness["source"] = "collector_latest"
        return flags, freshness

    def collect(self, now):
        label = now.strftime("%Y%m%d%H%M")
        flags, freshness = self.eligibility(now)
        def one(c):
            full = ("sh" if c.startswith("5") else "sz") + c
            try:
                return parse_minutes(c, self.fetch("https://ifzq.gtimg.cn/appstock/app/kline/mkline?param=" + full + ",m1,,320"), label)
            except (DataUnavailable, OSError, ValueError):
                return {}
        with ThreadPoolExecutor(max_workers=3) as pool:
            histories = dict(zip(CODES, pool.map(one, CODES)))
        bars = {c: {**histories[c][label], **flags[c]} for c in CODES if label in histories[c]}
        freshness["completed_bars"] = sorted(bars)
        return bars, histories, freshness
