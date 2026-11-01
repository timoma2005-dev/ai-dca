#!/usr/bin/env python3
"""首页「场内走势」长周期（3月/半年/1年）日收盘溢价：23 只场内基金（同首页分组）。

输出 OUT_DIR/home-premium.json（nginx 在 api:etf-history 鉴权后返回，SVIP 可看）：
  {generatedAt, start, end, dates[], funds:[{code,name,groupKey,prem[],close[]}]}，与 dates 对齐，缺值为 null。
溢价 = 收盘价 / 同日单位净值 − 1（QDII 净值 T+1，当日溢价次日补齐）。
增量：每只基金原始收盘/净值缓存在 OUT_DIR/home-premium-cache/{code}.json，最近 RECHECK_DAYS 天重抓。
数据源同 build_history.py（腾讯日 K，东方财富兜底；东方财富 lsjz 净值）。
"""
import datetime as dt, json, os, sys
from build_history import OUT_DIR, fetch_closes, fetch_navs, log, write_json

DAYS = int(os.environ.get('HOME_PREMIUM_DAYS', '400'))
RECHECK_DAYS = 12
FUNDS = [
    ('513100', '纳指ETF国泰', 'nasdaq-100'), ('159501', '纳指ETF嘉实', 'nasdaq-100'), ('159941', '纳指ETF广发', 'nasdaq-100'),
    ('159696', '纳指ETF易方达', 'nasdaq-100'), ('159659', '纳斯达克100ETF招商', 'nasdaq-100'), ('159632', '纳斯达克ETF华安', 'nasdaq-100'),
    ('513300', '纳斯达克ETF华夏', 'nasdaq-100'), ('513870', '纳指ETF富国', 'nasdaq-100'), ('513110', '纳指ETF华泰柏瑞', 'nasdaq-100'),
    ('159660', '纳指ETF汇添富', 'nasdaq-100'), ('513390', '纳指100ETF博时', 'nasdaq-100'), ('159513', '纳斯达克100ETF大成', 'nasdaq-100'),
    ('161130', '纳斯达克100LOF', 'nasdaq-100'),
    ('513500', '标普500ETF博时', 'sp500'), ('513650', '标普500ETF南方', 'sp500'), ('159612', '标普500ETF国泰', 'sp500'),
    ('159655', '标普500ETF华夏', 'sp500'), ('161125', '标普500LOF', 'sp500'),
    ('159577', '美国50ETF汇添富', 'us-50'), ('513850', '美国50ETF易方达', 'us-50'),
    ('159509', '纳指科技ETF景顺', 'nasdaq-tech'), ('161128', '标普信息科技LOF', 'nasdaq-tech'),
    ('563020', '红利低波ETF易方达', 'all'),
]
GROUPS = [{'key': 'all', 'label': '全部'}, {'key': 'nasdaq-100', 'label': '纳指 100'}, {'key': 'sp500', 'label': '标普 500'},
          {'key': 'us-50', 'label': '美国50'}, {'key': 'nasdaq-tech', 'label': '美国科技'}]


def main():
    end = dt.date.today()
    start = end - dt.timedelta(days=DAYS)
    cache_dir = os.path.join(OUT_DIR, 'home-premium-cache')
    os.makedirs(cache_dir, exist_ok=True)
    raw = {}
    for code, name, _ in FUNDS:
        path = os.path.join(cache_dir, f'{code}.json')
        try:
            cached = json.load(open(path))
        except (OSError, ValueError):
            cached = {'close': {}, 'nav': {}}
        have = sorted(cached['close'])
        fetch_from = start.isoformat()
        if have and have[0] <= (start + dt.timedelta(days=7)).isoformat():
            fetch_from = (end - dt.timedelta(days=RECHECK_DAYS)).isoformat()
        try:
            closes = fetch_closes(code, fetch_from, end.isoformat())
            navs = fetch_navs(code, fetch_from, end.isoformat())
        except Exception as e:  # noqa: BLE001  单只失败不影响其余，沿用缓存
            log('fetch fail', code, e)
            closes, navs = {}, {}
        cached['close'].update(closes)
        cached['nav'].update(navs)
        lo = start.isoformat()
        cached = {k: {d: v for d, v in cached[k].items() if d >= lo} for k in ('close', 'nav')}
        write_json(path, cached)
        raw[code] = cached
        log(code, name, 'close', len(cached['close']), 'nav', len(cached['nav']))
    # 交易日 = 纳指组过半有收盘价的日期
    count = {}
    for code, _, _ in FUNDS:
        for d in raw[code]['close']:
            count[d] = count.get(d, 0) + 1
    dates = sorted(d for d, n in count.items() if n >= len(FUNDS) // 2)
    # 最后一天若大多数还没净值（QDII T+1），去掉，避免末端全是空值
    while dates and sum(1 for c, _, _ in FUNDS if dates[-1] in raw[c]['nav']) < len(FUNDS) // 2:
        dates.pop()
    funds = []
    for code, name, group in FUNDS:
        c, n = raw[code]['close'], raw[code]['nav']
        prem, close = [], []
        for d in dates:
            cv, nv = c.get(d), n.get(d)
            close.append(cv)
            prem.append(round((cv / nv - 1) * 100, 4) if cv and nv else None)
        funds.append({'code': code, 'name': name, 'groupKey': group, 'prem': prem, 'close': close})
    out = {'schemaVersion': 1, 'generatedAt': dt.datetime.now().isoformat(timespec='seconds'), 'start': dates[0] if dates else None,
           'end': dates[-1] if dates else None, 'groups': GROUPS, 'dates': dates, 'funds': funds,
           'note': '溢价=收盘价/同日单位净值-1；QDII 净值 T+1 公布'}
    write_json(os.path.join(OUT_DIR, 'home-premium.json'), out)
    log('home-premium', len(dates), 'days', out['start'], '~', out['end'])


if __name__ == '__main__':
    sys.exit(main())
