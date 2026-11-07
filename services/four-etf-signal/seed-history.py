"""Seed ONLY the independent history archive from original local exports."""
import argparse
import csv
from datetime import date
import gzip
import hashlib
from pathlib import Path

from four_etf_signal.history import archive, initial_normal, save_bars, save_nav
from four_etf_signal.rules import CODES
from four_etf_signal.storage import atomic_json


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--source", type=Path, required=True)
    p.add_argument("--data-dir", type=Path, required=True)
    args = p.parse_args()
    args.data_dir.mkdir(parents=True, exist_ok=True)
    if (args.data_dir / "history.sqlite3").exists():
        p.error("history already exists; seed does not overwrite a live archive")
    inputs, counts = {}, {}
    with archive(args.data_dir / "history.sqlite3") as db:
        for c in CODES:
            full = ("sh" if c.startswith("5") else "sz") + c
            path = args.source / (full + ".csv.gz")
            inputs[str(path.name)] = hashlib.sha256(path.read_bytes()).hexdigest()
            with gzip.open(path, "rt") as f:
                rows = {r["ts"]: {"close": float(r["close"]), "volume": float(r["vol"])}
                        for r in csv.DictReader(f) if r["ts"] >= "202511070000"}
            save_bars(db, {c: rows}, source="local_original_m1")
            nav_path = args.source / "nav" / (full + "_nav.csv")
            inputs["nav/" + nav_path.name] = hashlib.sha256(nav_path.read_bytes()).hexdigest()
            with nav_path.open() as f:
                nav = {r["date"]: float(r["nav"]) for r in csv.DictReader(f) if r["date"] >= "2025-11-01"}
            save_nav(db, {c: nav}, source="local_sina_nav_export")
            counts[c] = {"minutes": len(rows), "nav_dates": len(nav)}
    initial_normal(args.data_dir)
    atomic_json(args.data_dir / "seed-manifest.json", {"fit_start": "2025-11-07", "input_sha256": inputs, "counts": counts})
    print(counts)


if __name__ == "__main__":
    main()
