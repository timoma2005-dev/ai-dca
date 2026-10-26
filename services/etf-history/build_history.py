#!/usr/bin/env python3
"""纳指 ETF 单只历史（份额 / 申购额度 / 收盘价 / 净值 / 溢价）构建器。

输出：OUT_DIR/{code}.json 与 OUT_DIR/index.json，由 nginx 在 SVIP 鉴权（api:etf-history）后静态返回。
增量：已有完整行跳过，最近 RECHECK 个交易日重抓（净值 / 份额晚到）。
数据源：
- 交易日与收盘价：腾讯日 K（不复权），东方财富 push2his 兜底
- 单位净值：东方财富 f10/lsjz（每页最多 20 条）
- 份额：上交所 ETF 规模接口（STAT_DATE，TOT_VOL 万份）/ 深交所基金规模 xlsx（txtStart/txtEnd，单位份）
- 申购额度：本机 etf-mirror /etf-pcf-limit（PCF 当日，回源 CF KV）
溢价 = 收盘价 / 同日单位净值 - 1。
"""
import argparse, datetime as dt, io, json, os, re, subprocess, sys, time, urllib.parse, zipfile

OUT_DIR = os.environ.get('ETF_HISTORY_DIR', '/var/lib/ai-dca-etf-history')
MIRROR = os.environ.get('ETF_MIRROR_URL', 'http://127.0.0.1:8082')
START = os.environ.get('ETF_HISTORY_START', '2025-10-13')
CODES = ['159501', '159509', '159513', '159632', '159659', '159660', '159696', '159941',
         '513100', '513110', '513300', '513390', '513870']
NAMES = {'159501': '纳指ETF嘉实', '159509': '纳指科技ETF', '159513': '纳斯达克100指数ETF', '159632': '纳斯达克ETF',
         '159659': '纳斯达克100ETF', '159660': '纳指100ETF', '159696': '纳指ETF易方达', '159941': '纳指ETF',
         '513100': '纳指ETF', '513110': '纳斯达克100ETF', '513300': '纳斯达克ETF', '513390': '纳指100ETF',
         '513870': '纳指ETF富国'}
RECHECK = 6
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36'


def log(*a):
    print(time.strftime('%H:%M:%S'), *a, flush=True)


def get(url, headers=None, local=False, timeout=30, tries=3, pause=0.4):
    """curl 取数（东方财富对 Python urllib 的 TLS 指纹直接断连）；404 返回 None。"""
    last = None
    for i in range(tries):
        cmd = ['curl', '-sS', '-L', '--compressed', '-m', str(timeout), '-A', UA, '-w', '\n%{http_code}']
        if local:
            cmd += ['--noproxy', '*']
        for k, v in (headers or {}).items():
            cmd += ['-H', f'{k}: {v}']
        p = subprocess.run(cmd + [url], capture_output=True)
        if p.returncode == 0:
            body, _, code = p.stdout.rpartition(b'\n')
            time.sleep(pause)
            if code == b'404':
                return None
            if code == b'200':
                return body
            last = f'http {code.decode()}'
        else:
            last = p.stderr.decode(errors='replace').strip()
        time.sleep(1.5 * (i + 1))
    raise RuntimeError(f'fetch failed {url}: {last}')


def secid(code):
    return ('1.' if code.startswith('5') else '0.') + code


def fetch_closes(code, start, end):
    """不复权日收盘：腾讯日 K 为主，东方财富兜底。"""
    sym = ('sh' if code.startswith('5') else 'sz') + code
    try:
        j = json.loads(get(f'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param={sym},day,{start},{end},640,', tries=4))
        d = (j.get('data') or {}).get(sym) or {}
        rows = d.get('day') or []
        if rows:
            return {r[0]: float(r[2]) for r in rows if start <= r[0] <= end}
    except (RuntimeError, ValueError) as e:
        log('tencent kline fail', code, e)
    url = ('https://push2his.eastmoney.com/api/qt/stock/kline/get?' + urllib.parse.urlencode({
        'secid': secid(code), 'fields1': 'f1', 'fields2': 'f51,f53', 'klt': 101, 'fqt': 0,
        'beg': start.replace('-', ''), 'end': end.replace('-', '')}))
    j = json.loads(get(url, tries=5))
    out = {}
    for line in (j.get('data') or {}).get('klines') or []:
        d, c = line.split(',')[:2]
        out[d] = float(c)
    return out


def fetch_navs(code, start, end):
    out, page = {}, 1
    while True:
        url = 'https://api.fund.eastmoney.com/f10/lsjz?' + urllib.parse.urlencode({
            'fundCode': code, 'pageIndex': page, 'pageSize': 20, 'startDate': start, 'endDate': end})
        j = json.loads(get(url, {'Referer': 'https://fundf10.eastmoney.com/'}, pause=0.25, tries=5))
        rows = ((j.get('Data') or {}).get('LSJZList')) or []
        for r in rows:
            try:
                out[r['FSRQ']] = float(r['DWJZ'])
            except (TypeError, ValueError, KeyError):
                pass
        total = int(j.get('TotalCount') or 0)
        if not rows or page * 20 >= total:
            return out
        page += 1


def fetch_sse_shares(date):
    url = ('https://query.sse.com.cn/commonQuery.do?isPagination=true&pageHelp.pageSize=2000&pageHelp.pageNo=1'
           '&sqlId=COMMON_SSE_ZQPZ_ETFZL_XXPL_ETFGM_SEARCH_L&STAT_DATE=' + date)
    j = json.loads(get(url, {'Referer': 'https://www.sse.com.cn/'}, pause=0.6))
    out = {}
    for r in j.get('result') or []:
        if r.get('STAT_DATE') == date and r.get('SEC_CODE') in CODES:
            try:
                out[r['SEC_CODE']] = round(float(r['TOT_VOL']) * 10000)
            except (TypeError, ValueError):
                pass
    return out


CELL = re.compile(r'<c r="([A-Z]+)\d+"[^>]*>(?:<is><t>(.*?)</t></is>|<v>(.*?)</v>)?</c>')


def fetch_szse_shares(start, end):
    url = ('https://www.szse.cn/api/report/ShowReport?SHOWTYPE=xlsx&CATALOGID=scsj_fund_jjgm&TABKEY=tab1&' +
           urllib.parse.urlencode({'txtStart': start, 'txtEnd': end, 'jjlb': 'ETF'}))
    body = get(url, timeout=60, pause=1.0)
    x = zipfile.ZipFile(io.BytesIO(body)).read('xl/worksheets/sheet1.xml').decode()
    out = {}
    for row in re.findall(r'<row[^>]*>(.*?)</row>', x, re.S):
        cells = {m[0]: (m[1] or m[2]) for m in CELL.findall(row)}
        code = cells.get('B')
        if code in CODES:
            try:
                out.setdefault(cells['A'], {})[code] = round(float(cells['D'].replace(',', '')))
            except (KeyError, ValueError):
                pass
    return out


def fetch_limit(code, date):
    body = get(f'{MIRROR}/etf-pcf-limit?code={code}&date={date}', local=True, timeout=45, pause=0.1)
    if not body:
        return None
    try:
        p = json.loads(body)
    except ValueError:
        return None
    if not isinstance(p, dict) or p.get('code') != code:
        return None

    def lim(kind, shares):
        return {'kind': p.get(kind) or None, 'shares': p.get(shares)}
    net, tot = lim('netSubscribeLimitKind', 'netSubscribeLimitShares'), lim('totalSubscribeLimitKind', 'totalSubscribeLimitShares')
    eff = net if net['kind'] == 'limited' else tot
    return {
        'eff': eff['kind'], 'effShares': eff['shares'] if eff['kind'] == 'limited' else None,
        'src': 'net' if net['kind'] == 'limited' else 'total',
        'tot': tot['shares'] if tot['kind'] == 'limited' else None,
        'net': net['shares'] if net['kind'] == 'limited' else None,
        'acctTot': p.get('accountTotalSubscribeLimitShares') if p.get('accountTotalSubscribeLimitKind') == 'limited' else None,
        'acctNet': p.get('accountNetSubscribeLimitShares') if p.get('accountNetSubscribeLimitKind') == 'limited' else None,
        'allow': p.get('subscriptionAllowed') if isinstance(p.get('subscriptionAllowed'), bool) else None,
    }


def load(code):
    try:
        with open(os.path.join(OUT_DIR, f'{code}.json')) as f:
            return {r['d']: r for r in json.load(f)['rows']}
    except (OSError, ValueError, KeyError):
        return {}


def write_json(path, data):
    tmp = path + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(data, f, ensure_ascii=False, separators=(',', ':'))
    os.chmod(tmp, 0o644)
    os.replace(tmp, path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--codes', default=','.join(CODES))
    ap.add_argument('--end', default=dt.date.today().isoformat())
    args = ap.parse_args()
    codes = [c for c in args.codes.split(',') if c in CODES]
    os.makedirs(OUT_DIR, exist_ok=True)
    end = args.end
    closes = {c: fetch_closes(c, START, end) for c in codes}
    cal = sorted(set().union(*[set(v) for v in closes.values()]))
    cal = [d for d in cal if START <= d <= end]
    if not cal:
        log('no trading days'); return 1
    recheck = set(cal[-RECHECK:])
    existing = {c: load(c) for c in codes}
    # 历史额度种子（一次性从 CF KV etf-pcf:{code}:{yyyymmdd} 导出，见 export 说明）；缺的日期再走 etf-mirror。
    try:
        with open(os.environ.get('ETF_LIMITS_SEED', '/var/lib/ai-dca-etf-history-seed/limits-seed.json')) as f:
            seed = json.load(f)
    except (OSError, ValueError):
        seed = {}

    def complete(r):
        return r and all(r.get(k) is not None for k in ('sh', 'close', 'nav', 'eff'))

    need = {c: [d for d in cal if d in recheck or not complete(existing[c].get(d))] for c in codes}
    log('need', {c: len(v) for c, v in need.items()})
    # NAV
    navs = {}
    for c in codes:
        if need[c]:
            navs[c] = fetch_navs(c, min(need[c]), end)
    # shares
    shares = {}
    sse_days = sorted({d for c in codes if c.startswith('5') for d in need[c]})
    for i, d in enumerate(sse_days):
        try:
            shares[d] = fetch_sse_shares(d)
        except RuntimeError as e:
            log('sse fail', d, e)
        if i % 25 == 0:
            log('sse', i, len(sse_days))
    sz_days = sorted({d for c in codes if c.startswith('1') for d in need[c]})
    if sz_days:
        a = dt.date.fromisoformat(sz_days[0])
        b = dt.date.fromisoformat(sz_days[-1])
        while a <= b:
            e = min(a + dt.timedelta(days=6), b)
            try:
                for d, m in fetch_szse_shares(a.isoformat(), e.isoformat()).items():
                    shares.setdefault(d, {}).update(m)
            except (RuntimeError, zipfile.BadZipFile) as ex:
                log('szse fail', a, ex)
            a = e + dt.timedelta(days=1)
    # build
    stamp = dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).isoformat(timespec='seconds')
    index = []
    for c in codes:
        rows = existing[c]
        for n, d in enumerate(need[c]):
            old = rows.get(d) or {}
            lim = seed.get(c, {}).get(d)
            if lim is None and (d in recheck or old.get('eff') is None):
                try:
                    lim = fetch_limit(c, d)
                except RuntimeError as ex:
                    log('limit fail', c, d, ex)
            r = dict(old)
            r['d'] = d
            r['close'] = closes[c].get(d, old.get('close'))
            r['nav'] = navs.get(c, {}).get(d, old.get('nav'))
            sh = (shares.get(d) or {}).get(c)
            r['sh'] = sh if sh is not None else old.get('sh')
            if lim:
                r.update(lim)
            rows[d] = r
            if n % 50 == 0:
                log(c, n, len(need[c]))
        out, prev = [], None
        for d in cal:
            r = rows.get(d)
            if not r:
                continue
            r['prem'] = round((r['close'] / r['nav'] - 1) * 100, 3) if r.get('close') and r.get('nav') else None
            r['dsh'] = r['sh'] - prev['sh'] if prev and r.get('sh') is not None and prev.get('sh') is not None else None
            r['dprem'] = round(r['prem'] - prev['prem'], 3) if prev and r['prem'] is not None and prev.get('prem') is not None else None
            out.append(r)
            prev = r
        write_json(os.path.join(OUT_DIR, f'{c}.json'), {
            'version': 1, 'code': c, 'name': NAMES.get(c, c), 'market': 'SSE' if c.startswith('5') else 'SZSE',
            'generatedAt': stamp, 'start': out[0]['d'] if out else None, 'end': out[-1]['d'] if out else None,
            'premiumBasis': 'close/nav-1 (same day)', 'rows': out})
        gaps = {k: sum(1 for r in out if r.get(k) is None) for k in ('sh', 'close', 'nav', 'eff')}
        index.append({'code': c, 'name': NAMES.get(c, c), 'rows': len(out), 'end': out[-1]['d'] if out else None, 'gaps': gaps})
        log('wrote', c, len(out), gaps)
    if set(codes) == set(CODES):
        write_json(os.path.join(OUT_DIR, 'index.json'), {'version': 1, 'generatedAt': stamp, 'funds': index})
    return 0


if __name__ == '__main__':
    sys.exit(main())
