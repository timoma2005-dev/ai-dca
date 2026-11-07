"""Read-only CN source acceptance probe; never calls notify or changes a source."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
import csv
import json
from pathlib import Path
import sqlite3
import statistics
import argparse

from four_etf_signal.calendar import previous_day
from four_etf_signal.data import TZ, fetch_nav, get_json, parse_minutes, quote_eligibility
from four_etf_signal.rules import CODES, INITIAL_NORMALS, DataUnavailable
from four_etf_signal.storage import atomic_json


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--nav-dir", type=Path, required=True)
    p.add_argument("--archive", type=Path, required=True)
    p.add_argument("--output", type=Path, required=True)
    args = p.parse_args()
    now = datetime.now(TZ)
    result = {"checked_at": now.isoformat(), "proxy_policy": "explicitly_bypassed", "selected_nav": "eastmoney_f10_lsjz",
              "price_close": "tencent_completed_m1", "collector_role": "freshness_and_suspension_only"}
    latest = get_json("http://127.0.0.1:18080/latest")
    result["collector_generated_at"] = latest["generated_at"]
    try:
        _, result["collector_freshness"] = quote_eligibility(latest, now)
    except DataUnavailable as e:
        result["collector_current_gate"] = str(e)
    with ThreadPoolExecutor(max_workers=3) as pool:
        histories = dict(zip(CODES, pool.map(fetch_nav, CODES)))
    result["nav_probe"] = {}
    for c in CODES:
        full = ("sh" if c.startswith("5") else "sz") + c
        with (args.nav_dir / (full + "_nav.csv")).open() as f:
            local = {r["date"]: float(r["nav"]) for r in csv.DictReader(f)}
        overlap = sorted(set(local) & set(histories[c]))
        mismatches = [d for d in overlap if abs(local[d] - histories[c][d]) > 1e-10]
        result["nav_probe"][c] = {"latest_date": max(histories[c]), "latest_nav": histories[c][max(histories[c])],
                                  "overlapping_dates": overlap, "mismatches": mismatches}
        assert overlap and not mismatches
    result["minute_probe"] = {}
    with sqlite3.connect("file:/root/m1store/stockdb_m1.db?mode=ro", uri=True) as db:
        for c in CODES:
            full = ("sh" if c.startswith("5") else "sz") + c
            day = "20261106"
            response = get_json("https://ifzq.gtimg.cn/appstock/app/kline/mkline?param=" + full + ",m1,,320")
            bars = parse_minutes(c, response, day + "1500")
            canonical = {str(ts): (close, volume) for ts, close, volume in db.execute(
                "SELECT ts,close,vol FROM k1 WHERE code=? AND ts LIKE ? ORDER BY ts", (full, day + "%"))}
            mismatch = [ts for ts, row in bars.items() if ts not in canonical or abs(row["close"] - canonical[ts][0]) > 1e-10
                        or (row["volume"] > 0) != (canonical[ts][1] > 0)]
            result["minute_probe"][c] = {"date": "2026-11-06", "returned_minutes": len(bars), "source_db_minutes": len(canonical),
                                         "first": min(bars), "last": max(bars), "close_or_eligibility_mismatches": mismatch}
            assert len(bars) == 180 and not mismatch
    with sqlite3.connect("file:/root/ai-dca/services/etf-mirror/mirror.db?mode=ro", uri=True) as db:
        result["rejected_mirror"] = {}
        for c in CODES:
            row = db.execute("SELECT payload FROM mirror WHERE kind='limit' AND key=?", (c,)).fetchone()
            payload = json.loads(row[0])
            result["rejected_mirror"][c] = {k: payload.get(k) for k in ["source", "date", "prevDayDate", "prevDayNav", "nav"]}
    with sqlite3.connect("file:/root/ai-dca/services/market-collector/data/market-collector.sqlite3?mode=ro", uri=True) as db:
        result["rejected_collector_nav_latest"] = {c: db.execute("SELECT max(nav_date) FROM nav_daily WHERE symbol=?", (c,)).fetchone()[0] for c in CODES}
    result["initial_medians_independently_recomputed"] = {}
    with sqlite3.connect(args.archive.resolve().as_uri() + "?mode=ro", uri=True) as db:
        for c in CODES:
            nav = dict(db.execute("SELECT date,value FROM nav WHERE code=?", (c,)))
            values = []
            for ts, close in db.execute("SELECT ts,close FROM bars WHERE code=? AND ts>='202511070000' AND ts<='202611062359' AND volume>0 AND close>0", (c,)):
                day = datetime.strptime(ts[:8], "%Y%m%d").date()
                previous = previous_day(day).isoformat()
                assert previous in nav
                values.append(100 * (close / nav[previous] - 1))
            median = statistics.median(values)
            result["initial_medians_independently_recomputed"][c] = {"positive_minutes": len(values), "median_pp": median, "brief_pp": INITIAL_NORMALS[c]}
            assert round(median, 4) == INITIAL_NORMALS[c]
    result["passed"] = True
    atomic_json(args.output, result)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
