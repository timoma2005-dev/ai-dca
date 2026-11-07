"""Export a small, immutable oracle from the frozen round3b implementation.

Run locally with numpy/pandas; never modifies backtest inputs or old pyc files.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
from pathlib import Path
import sys

sys.dont_write_bytecode = True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--backtest-root', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    root = args.backtest_root.resolve()
    sys.path.insert(0, str(root))
    import numpy as np
    from round3.core import load_market
    from round3b.legacy import LegacyMarket, frozen_engine
    market = load_market(cutoff=20261106)
    adapter = LegacyMarket(market)
    engine = frozen_engine()
    values = engine.Features(adapter).get('rp', 30, 1440)
    snapshots = adapter.at(1440)
    codes = [str(c)[-6:] for c in market.codes]
    first = len(market.days) - 30
    days = [str(d) for d in market.days[first - 30:]]
    daily_path = root / 'results/round3b/reference/main/B_REL_daily.csv'
    events_path = root / 'results/round3b/reference/B_REL_events.csv'
    daily = {r['date']: r for r in csv.DictReader(daily_path.open())}
    events = {r['signal_date']: r for r in csv.DictReader(events_path.open())}
    cases = []
    held = daily[str(market.days[first - 1])]['held_code'][-6:]
    for d in range(first, len(market.days)):
        day = str(market.days[d])
        cur = values[d].copy()
        valid = market.valid[snapshots[d]] & np.isfinite(cur)
        assert valid[codes.index(held)]
        outside = valid.copy()
        outside[codes.index(held)] = False
        target_index = int(np.argmin(np.where(outside, cur, np.inf)))
        target = codes[target_index]
        gap = float(cur[codes.index(held)] - cur[target_index]) * 10000
        event = events.get(day)
        cases.append(dict(date=day, holding=held, target=target, gap_bp=gap,
                          decision='rotate' if event else 'hold', next_holding=daily[day]['held_code'][-6:],
                          execution_time=str(event['exec_ts'])[-4:] if event else None,
                          sell_close=float(event['sell_price']) if event else None,
                          buy_close=float(event['buy_price']) if event else None))
        if event:
            assert event['sell_code'][-6:] == held and event['buy_code'][-6:] == target
        held = daily[day]['held_code'][-6:]
    files = ['discovery/engine.py', 'discovery/market.py', 'round3/core.py', 'round3b/legacy.py',
             'round3b/PROTOCOL.md', str(events_path.relative_to(root)), str(daily_path.relative_to(root)),
             'results/market_cache.npz']
    result = dict(schema=1, strategy='B_REL', date_end='20261106', days=days, codes=codes,
                  prices={str(market.days[d]): {c: float(market.marks[snapshots[d], j]) for j, c in enumerate(codes)}
                          for d in range(first - 30, len(market.days))},
                  valid={str(market.days[d]): {c: bool(market.valid[snapshots[d], j]) for j, c in enumerate(codes)}
                         for d in range(first - 30, len(market.days))},
                  cases=cases, source_sha256={p: hashlib.sha256((root / p).read_bytes()).hexdigest() for p in files})
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False) + '\n')
    print(json.dumps({'sessions': len(cases), 'start': cases[0]['date'], 'end': cases[-1]['date'],
                      'rotations': [c for c in cases if c['decision'] == 'rotate'], 'last': cases[-1]}, ensure_ascii=False))


if __name__ == '__main__':
    main()
