"""Own minute/NAV archive and causal quarterly medians; sources stay read-only."""
from datetime import date, datetime, timedelta
from pathlib import Path
import sqlite3
import statistics

from .calendar import next_quarter, previous_day, sessions
from .rules import CODES, INITIAL_NORMALS, DataUnavailable, digest, positive
from .storage import atomic_json, read_json


def archive(path):
    db = sqlite3.connect(path, timeout=10)
    db.execute("CREATE TABLE IF NOT EXISTS bars(code TEXT,ts TEXT,close REAL,volume REAL,source TEXT,PRIMARY KEY(code,ts))")
    db.execute("CREATE TABLE IF NOT EXISTS nav(code TEXT,date TEXT,value REAL,source TEXT,PRIMARY KEY(code,date))")
    return db


def save_nav(db, histories, source):
    db.executemany("INSERT OR REPLACE INTO nav VALUES(?,?,?,?)",
                   [(c, day, value, source) for c, rows in histories.items() for day, value in rows.items()])
    db.commit()


def save_bars(db, histories, source="tencent_m1"):
    db.executemany("INSERT OR REPLACE INTO bars VALUES(?,?,?,?,?)",
                   [(c, ts, bar["close"], bar["volume"], source)
                    for c, rows in histories.items() for ts, bar in rows.items()])
    db.commit()


def merge_source(db, source_path, start, end):
    uri = Path(source_path).resolve().as_uri() + "?mode=ro"
    with sqlite3.connect(uri, uri=True, timeout=10) as source:
        for c in CODES:
            full = ("sh" if c.startswith("5") else "sz") + c
            rows = source.execute("SELECT ts,close,vol FROM k1 WHERE code=? AND ts>=? AND ts<=? ORDER BY ts",
                                  (full, start.strftime("%Y%m%d") + "0000", end.strftime("%Y%m%d") + "2359"))
            db.executemany("INSERT OR REPLACE INTO bars VALUES(?,?,?,?,?)",
                           ((c, str(ts), close, volume, "cn_k1_readonly") for ts, close, volume in rows))
    db.commit()


def initial_normal(directory):
    path = Path(directory) / "normal-2026-11-07.json"
    if not path.exists():
        record = {"effective": "2026-11-07", "next_recalculation": "2027-01-01",
                  "fit_start": "2025-11-07", "fit_end": "2026-11-06",
                  "method": "positive_volume_minute_median", "normal_pp": INITIAL_NORMALS,
                  "source": "FOUR_ETF_LIVE_BRIEF.md"}
        record["sha256"] = digest(record)
        atomic_json(path, record)


def load_normal(directory, day):
    records = [read_json(p) for p in Path(directory).glob("normal-????-??-??.json")]
    records = [r for r in records if r.get("effective", "9999") <= day.isoformat()]
    if not records:
        raise DataUnavailable("normal_unavailable")
    record = max(records, key=lambda r: r["effective"])
    if (record.get("sha256") != digest({k: v for k, v in record.items() if k != "sha256"})
            or not record.get("fit_start") or record.get("fit_end", "9999") >= record["effective"]
            or record.get("next_recalculation", "") <= day.isoformat()
            or set(record.get("normal_pp", {})) != set(CODES)):
        raise DataUnavailable("normal_expired_or_invalid")
    return record


def completed_labels(day):
    prefix = day.strftime("%Y%m%d")
    return {prefix + f"{m // 60:02d}{m % 60:02d}" for a, b in ((571, 690), (781, 900)) for m in range(a, b + 1)}


def calculate_normal(db, effective):
    if effective.month not in (1, 4, 7, 10) or effective.day != 1:
        raise DataUnavailable("not_a_quarter_boundary")
    start, end = date(effective.year - 1, effective.month, 1), effective - timedelta(days=1)
    days = sessions(start, end)
    if len(days) < 200:
        raise DataUnavailable("insufficient_training_year")
    normal, counts, input_rows = {}, {}, []
    for c in CODES:
        nav = dict(db.execute("SELECT date,value FROM nav WHERE code=?", (c,)))
        rows = {str(ts): (close, volume) for ts, close, volume in db.execute(
            "SELECT ts,close,volume FROM bars WHERE code=? AND ts>=? AND ts<? ORDER BY ts",
            (c, start.strftime("%Y%m%d"), effective.strftime("%Y%m%d")))}
        values = []
        for day in days:
            expected = completed_labels(day)
            if not expected.issubset(rows):
                raise DataUnavailable("incomplete_training_minutes:" + c + ":" + day.isoformat())
            nav_day = previous_day(day).isoformat()
            value = nav.get(nav_day)
            if not positive(value):
                raise DataUnavailable("missing_training_t1_nav:" + c + ":" + nav_day)
            for ts in sorted(expected):
                close, volume = rows[ts]
                if not positive(close) or not isinstance(volume, (int, float)) or volume < 0:
                    raise DataUnavailable("invalid_training_minute")
                input_rows.append([c, ts, close, volume, nav_day, value])
                if positive(volume):
                    values.append(100 * (close / value - 1))
        if len(values) < 1000:
            raise DataUnavailable("too_few_positive_minutes:" + c)
        normal[c], counts[c] = statistics.median(values), len(values)
    record = {"effective": effective.isoformat(), "next_recalculation": next_quarter(effective).isoformat(),
              "fit_start": start.isoformat(), "fit_end": end.isoformat(), "trading_days": len(days),
              "method": "positive_volume_minute_median", "normal_pp": normal, "positive_minutes": counts,
              "input_sha256": digest(input_rows), "source": "independent_history_archive"}
    record["sha256"] = digest(record)
    return record


def recalculate(directory, source_db, effective):
    path = Path(directory) / ("normal-" + effective.isoformat() + ".json")
    if path.exists():
        return load_normal(directory, effective)
    start = date(effective.year - 1, effective.month, 1)
    with archive(Path(directory) / "history.sqlite3") as db:
        merge_source(db, source_db, start, effective - timedelta(days=1))
        record = calculate_normal(db, effective)
    atomic_json(path, record)
    return record
