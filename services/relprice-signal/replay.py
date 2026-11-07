"""Replay the actual CN minute database against the immutable backtest oracle."""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
from pathlib import Path
import sqlite3

from relprice_signal.data import exchange_code, history_from_db
from relprice_signal.rules import CODES, decide, first_common_bar


def replay(database, reference):
    days = reference['days']
    assert tuple(reference['codes']) == CODES
    prices, valid = history_from_db(database, days)
    max_price_error = max(abs(prices[d][c] - reference['prices'][d][c]) for d in days for c in CODES)
    assert max_price_error < 1e-12, ('CN history differs from frozen input', max_price_error)
    assert valid == reference['valid'], 'CN signal eligibility differs from frozen input'
    held = reference['cases'][0]['holding']
    rows = []
    with sqlite3.connect(Path(database).resolve().as_uri() + '?mode=ro', uri=True) as db:
        for expected in reference['cases']:
            day = expected['date']
            index = days.index(day)
            decision = decide([prices[d] for d in days[index - 30:index]], prices[day], valid[day], held)
            execution = None
            if decision['decision'] == 'rotate':
                bars = {}
                for code in (held, decision['target']):
                    data = db.execute('SELECT ts,open,close,high,low,vol FROM k1 WHERE code=? AND ts>=? AND ts<=? ORDER BY ts',
                                      (exchange_code(code), day + '1441', day + '1500')).fetchall()
                    bars[code] = [list(row) for row in data]
                execution = first_common_bar(bars, held, decision['target'])
                if not execution:
                    decision.update(decision='hold', next_holding=held)
            for key in ('holding', 'target', 'decision', 'next_holding'):
                assert decision[key] == expected[key], (day, key, decision[key], expected[key])
            gap_error = abs(decision['gap_bp'] - expected['gap_bp'])
            assert gap_error < 1e-8, (day, 'gap', gap_error)
            assert (execution['time'] if execution else None) == expected['execution_time']
            if execution:
                for field in ('sell_close', 'buy_close'):
                    assert abs(execution[field] - expected[field]) < 1e-12, (day, field, execution[field], expected[field])
            rows.append({**{key: decision[key] for key in ('holding', 'target', 'gap_bp', 'decision', 'next_holding')},
                         'date': day, 'backtest_holding': expected['next_holding'], 'backtest_gap_bp': expected['gap_bp'],
                         'gap_error_bp': gap_error, 'execution_time': execution['time'] if execution else '', 'match': True})
            held = decision['next_holding']
    special = {row['date']: row for row in rows}
    assert special['20261015']['holding'] == '159501' and special['20261015']['next_holding'] == '513110' and special['20261015']['decision'] == 'rotate'
    assert special['20261106']['holding'] == '513110' and special['20261106']['decision'] == 'hold'
    return rows, {'sessions': len(rows), 'all_match': True, 'max_price_error': max_price_error,
                  'max_gap_error_bp': max(row['gap_error_bp'] for row in rows),
                  'rotations': [row for row in rows if row['decision'] == 'rotate'], 'last': rows[-1],
                  'backtest_source_sha256': reference['source_sha256'], 'database': str(database),
                  'reference_sha256': hashlib.sha256(json.dumps(reference, sort_keys=True).encode()).hexdigest()}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--db', required=True, type=Path)
    parser.add_argument('--reference', required=True, type=Path)
    parser.add_argument('--output-dir', required=True, type=Path)
    args = parser.parse_args()
    reference = json.loads(args.reference.read_text())
    rows, report = replay(args.db, reference)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    with (args.output_dir / 'replay-last30.csv').open('w') as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    (args.output_dir / 'replay-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({k: v for k, v in report.items() if k != 'backtest_source_sha256'}, ensure_ascii=False))


if __name__ == '__main__':
    main()
