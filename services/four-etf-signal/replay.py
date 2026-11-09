"""Offline full-day replay plus the brief's fixed-holding closing diagnostic.

Historical hold-day initial holding comes from the frozen replication ledger;
it is deliberately distinct from the user's deployment holding as of Nov 6.
No notification client is imported or called by this script.
"""
import argparse
import csv
from datetime import date
import gzip
import json
from pathlib import Path
import sqlite3

from four_etf_signal.calendar import nav_day
from four_etf_signal.rules import CODES, INITIAL_NORMALS, advance, digest
from four_etf_signal.storage import atomic_json

LEGACY = dict(zip(CODES, (4.04, 2.74, 2.77, 3.00)))


def read_day(day, data_root, db_path=None):
    label = day.strftime("%Y%m%d")
    bars, nav = {}, {}
    for c in CODES:
        full = ("sh" if c.startswith("5") else "sz") + c
        nav_path = data_root / "nav" / (full + "_nav.csv")
        expected = nav_day(day).isoformat()
        with nav_path.open() as f:
            nav[c] = next(float(r["nav"]) for r in csv.DictReader(f) if r["date"] == expected)
        if db_path:
            with sqlite3.connect(Path(db_path).resolve().as_uri() + "?mode=ro", uri=True) as db:
                rows = db.execute("SELECT ts,close,vol FROM k1 WHERE code=? AND ts LIKE ? ORDER BY ts", (full, label + "%")).fetchall()
        else:
            with gzip.open(data_root / (full + ".csv.gz"), "rt") as f:
                rows = [(r["ts"], float(r["close"]), float(r["vol"])) for r in csv.DictReader(f) if r["ts"].startswith(label)]
        for ts, close, volume in rows:
            bars.setdefault(str(ts), {})[c] = {"close": close, "volume": volume}
    if len(bars) != 240 or any(len(x) != 4 for x in bars.values()):
        raise AssertionError("full-day replay needs all 240 original minutes per ETF")
    return bars, nav


def simulate(bars, nav, holding, normals):
    state = {"holding": holding, "revision": 0, "pending": None, "last_minute": ""}
    traces, confirmations = [], []
    for label, minute in sorted(bars.items()):
        before = state["holding"]
        state, row = advance(state, label, minute, nav, normals)
        trace = {"minute": label, "holding_before": before, "holding_after": state["holding"], **row}
        traces.append(trace)
        if row.get("confirmed"):
            confirmations.append(row["confirmed"])
    return {"initial_holding": holding, "final_holding": state["holding"], "evaluated_minutes": len(traces),
            "confirmed_switches": confirmations, "would_push_count": len(confirmations), "actual_push_count": 0,
            "trace_sha256": digest(traces)}, traces


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--data-root", type=Path, required=True)
    p.add_argument("--db")
    p.add_argument("--output-dir", type=Path, required=True)
    p.add_argument("--replication-ledger", type=Path)
    args = p.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    ledger = args.replication_ledger or args.data_root.parent / "four_etf/results/scenarios/supplied_d1_zero_daily.csv"
    with ledger.open() as f:
        historical = next(r for r in csv.DictReader(f) if r["date"] == "2026-11-05")
    assert historical["begin_holding"] == historical["end_holding"] == "sz159941"
    assert int(historical["switches"]) == 0
    report = {"network_used": False, "actual_pushes": 0, "hold_day_start_source": str(ledger),
              "hold_day_ledger_row": historical, "days": {}, "closing_diagnostics": {}}
    for text, holding in (("2026-11-05", "159941"), ("2026-11-06", "159696")):
        bars, nav = read_day(date.fromisoformat(text), args.data_root, args.db)
        summary, traces = simulate(bars, nav, holding, INITIAL_NORMALS)
        summary["input_sha256"] = digest({"bars": bars, "nav": nav})
        report["days"][text] = summary
        (args.output_dir / (text + ".jsonl")).write_text("".join(json.dumps(r, ensure_ascii=False, sort_keys=True) + "\n" for r in traces))
        if text == "2026-11-05":
            assert summary["would_push_count"] == 0
        else:
            label = max(bars)
            for name, normals in (("historical_frozen", LEGACY), ("live_seed", INITIAL_NORMALS)):
                initial = {"holding": "159696", "revision": 0, "last_minute": "", "pending": None}
                state, row = advance(initial, label, bars[label], nav, normals)
                # T-2 NAV basis (2026-11-09): the T-1 brief numbers (16.86/15.78/1.08) no longer apply; report only.
                assert row["confirmed"] is None
                report["closing_diagnostics"][name] = {"minute": label, "normal_pp": normals, **row, "would_push_count": 0}
    report["passed"] = True
    report["interpretation"] = "11-05 hold path starts 159941 from replication ledger; 11-06 full deployment-initial replay starts 159696 and may rotate earlier. The requested 15:00 159696→159941 check is a separate fixed-holding diagnostic, cancelled without push."
    atomic_json(args.output_dir / "replay-report.json", report)
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
