#!/usr/bin/env python3
"""换基引导「平时谁贵谁便宜」分钟线统计。

分钟溢价 = 该分钟收盘价 / 当日单位净值 - 1（%），与日线口径一致（close/nav-1），只是逐分钟取价。
分钟价：/root/m1store/stockdb_m1.db（长历史）+ /root/m1store/m1.db（近期补齐），表 k1(code, ts=YYYYMMDDHHMM, close)。
净值：/var/lib/ai-dca-etf-history/<code>.json rows[].{d, nav}；当天净值未出（QDII T+1）的交易日跳过。
输出：每个窗口（近 N 个有净值的交易日）每只相对同分钟中位数的偏离中位数 rel，以及每组配对分钟价差的中位数/25%/75% 分位。
"""
import json
import os
import sqlite3
import sys
from datetime import datetime, timezone

import numpy as np

CODES = ['159501', '159509', '159513', '159632', '159659', '159660', '159696', '159941', '513100', '513110', '513300', '513390', '513870']
WINDOWS = [60, 120, 180]
DBS = ['/root/m1store/stockdb_m1.db', '/root/m1store/m1.db']
NAV_DIR = '/var/lib/ai-dca-etf-history'
OUT = os.environ.get('SWITCH_GUIDE_MINUTE_FILE', '/var/lib/ai-dca-cn-data/switch-guide-minute.json')


def prefixed(code):
    return ('sh' if code.startswith('5') else 'sz') + code


def load_nav():
    nav = {}
    for code in CODES:
        path = os.path.join(NAV_DIR, f'{code}.json')
        try:
            rows = json.load(open(path)).get('rows') or []
        except Exception:
            continue
        nav[code] = {r['d'].replace('-', ''): float(r['nav']) for r in rows if r.get('d') and r.get('nav')}
    return nav


def load_minutes(nav, since):
    """{day: {ts: {code: premium}}}，先读长库，近期缺的天由 m1.db 补。"""
    data = {}
    seen = {code: set() for code in CODES}
    for db in DBS:
        if not os.path.exists(db):
            continue
        con = sqlite3.connect(f'file:{db}?mode=ro', uri=True)
        for code in CODES:
            navs = nav.get(code) or {}
            rows = con.execute('SELECT ts, close FROM k1 WHERE code = ? AND ts >= ? ORDER BY ts', (prefixed(code), since + '0000')).fetchall()
            added = set()
            for ts, close in rows:
                day = ts[:8]
                if day in seen[code] or day not in navs or not close:
                    continue
                prem = (float(close) / navs[day] - 1) * 100
                data.setdefault(day, {}).setdefault(ts, {})[code] = prem
                added.add(day)
            seen[code] |= added
        con.close()
    return data


def r2(v):
    return None if v is None or not np.isfinite(v) else round(float(v), 2)


def main():
    nav = load_nav()
    all_days = sorted({d for m in nav.values() for d in m})
    if len(all_days) < 5:
        print('not enough nav days', file=sys.stderr)
        return 1
    since = all_days[-max(WINDOWS) - 5] if len(all_days) > max(WINDOWS) + 5 else all_days[0]
    data = load_minutes(nav, since)
    days = sorted(d for d, mins in data.items() if sum(1 for v in mins.values() if len(v) >= 2) >= 30)
    win = {}
    for n in WINDOWS:
        use = days[-n:]
        if not use:
            continue
        mat = []
        for d in use:
            for ts in sorted(data[d]):
                row = data[d][ts]
                if len(row) >= 2:
                    mat.append([row.get(c, np.nan) for c in CODES])
        m = np.array(mat, dtype=float)
        mid = np.nanmedian(m, axis=1, keepdims=True)
        rel = m - mid
        pairs = {}
        for i, a in enumerate(CODES):
            for j in range(i + 1, len(CODES)):
                b = CODES[j]
                diff = m[:, i] - m[:, j]
                diff = diff[np.isfinite(diff)]
                if diff.size < 240:
                    continue
                q25, q50, q75 = np.percentile(diff, [25, 50, 75])
                pairs[f'{a}-{b}'] = [r2(q50), r2(q25), r2(q75)]
        win[str(n)] = {
            'from': f'{use[0][:4]}-{use[0][4:6]}-{use[0][6:]}',
            'to': f'{use[-1][:4]}-{use[-1][4:6]}-{use[-1][6:]}',
            'days': len(use),
            'minutes': int(m.shape[0]),
            'rel': {c: r2(np.nanmedian(rel[:, k])) for k, c in enumerate(CODES) if np.isfinite(rel[:, k]).any()},
            'pairs': pairs,
        }
    out = {'basis': 'minute', 'premiumBasis': 'minute close / same-day nav - 1', 'generatedAt': datetime.now(timezone.utc).isoformat(), 'win': win}
    tmp = OUT + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(out, f, ensure_ascii=False)
    os.replace(tmp, OUT)
    print(json.dumps({k: {kk: v[kk] for kk in ('from', 'to', 'days', 'minutes')} for k, v in win.items()}))
    return 0


if __name__ == '__main__':
    sys.exit(main())
