"""Full-year archive backtest of the fourETF minute state machine, NAV lag T-1 vs T-2 (each with its own in-sample normal)."""
import sys, sqlite3, statistics, json
sys.path.insert(0, '/root/ai-dca-four-etf-live/services/four-etf-signal')
from datetime import date
from four_etf_signal.calendar import previous_day, nav_day, sessions
from four_etf_signal.history import completed_labels
from four_etf_signal.rules import CODES, advance
db = sqlite3.connect('/var/lib/ai-dca-four-etf/history.sqlite3')
days = sessions(date(2025, 11, 7), date(2026, 11, 6))
nav = {c: dict(db.execute('select date,value from nav where code=?', (c,))) for c in CODES}
bars = {}
for c in CODES:
    for ts, cl, v in db.execute('select ts,close,volume from bars where code=? and ts>=? and ts<?', (c, '20251107', '20261107')):
        bars.setdefault(ts, {})[c] = {'close': cl, 'volume': v}
def run(lag, start='159941'):
    f = previous_day if lag == 1 else nav_day
    normal = {}
    for c in CODES:
        vals = [100 * (bars[ts][c]['close'] / nav[c][f(d).isoformat()] - 1) for d in days for ts in completed_labels(d)
                if c in bars.get(ts, {}) and bars[ts][c]['volume'] > 0]
        normal[c] = round(statistics.median(vals), 4)
    st = {'holding': start, 'revision': 0, 'pending': None, 'last_minute': ''}
    value, entry, sw, per_month = 1.0, None, [], {}
    first = min(bars); entry = bars[first][start]['close']
    for d in days:
        n = {c: nav[c][f(d).isoformat()] for c in CODES}
        for ts in sorted(completed_labels(d)):
            b = {c: dict(bars[ts][c], stale=False, suspended=False) for c in CODES if c in bars.get(ts, {})}
            st, r = advance(st, ts, b, n, normal)
            k = r.get('confirmed')
            if k:
                value *= k['sell_close'] / entry; entry = k['buy_close']
                sw.append((ts, k['holding'], k['target'], round(k['gap_pp'], 3)))
                per_month[ts[:6]] = per_month.get(ts[:6], 0) + 1
    last = max(bars); value *= bars[last][st['holding']]['close'] / entry
    bh = {c: round(bars[last][c]['close'] / bars[first][c]['close'] - 1, 4) for c in CODES}
    return {'lag': 'T-%d' % lag, 'normal_pp': normal, 'switches': len(sw), 'strategy_return': round(value - 1, 4),
            'buy_hold': bh, 'final_holding': st['holding'], 'per_month': per_month, 'last5': sw[-5:]}
out = [run(1), run(2)]
json.dump(out, open('/var/lib/ai-dca-four-etf/backtest-t1-vs-t2-20261109.json', 'w'), indent=1)
for o in out: print(json.dumps(o, ensure_ascii=False))
