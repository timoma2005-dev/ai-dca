#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ai-dca ETF 份额数据本地镜像服务（CN 机）。

背景：/api/etf-pcf-shares 与 /api/etf-pcf-limit 由 CF worker（ai-dca-etf-shares）
提供，CN 机跨境访问 TLS 握手 3~8s，前端直连体验差。本服务：

- 后台线程定期从 CF worker 拉取份额投影（latest）与 13 只目标基金的 PCF 限额，
  原样存入本地 SQLite（表 mirror：kind/key/payload/status/fetched_at）；
- HTTP 提供 /etf-pcf-shares、/etf-pcf-limit：命中 SQLite 毫秒级返回；
  未命中（如 ?date= 历史日期、非目标 code）同步回源 CF 并落库；
- CF 不可达时持续返回最近一次成功数据（宁旧勿断）；
- 响应体与 worker 完全一致（前端有严格 schema 校验），仅透传。

部署：见同目录 README；nginx 将 /api/etf-pcf-shares、/api/etf-pcf-limit
指向本服务（127.0.0.1:8082）。
"""

import http.client
import json
import os
import socket
import sqlite3
import ssl
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

UPSTREAM = os.environ.get("ETF_MIRROR_UPSTREAM", "https://api.freebacktrack.tech")
# CF anycast IPv4 候选池：服务器无 IPv6 路由（系统 DNS 会返回 AAAA），跨境 TLS
# 握手 3~8s 且各 anycast 入口时延漂移大。故不再固定某个 IP，而是每轮后台同步前
# 对候选池做一次“优选”（并发测 TCP+TLS 握手耗时，取最快）。
# 候选池 = 环境变量静态池 ∪ 域名实时 A 记录。
UPSTREAM_IPS = [
    ip.strip() for ip in os.environ.get(
        "ETF_MIRROR_UPSTREAM_IPS", "104.21.38.17,172.67.217.77"
    ).split(",") if ip.strip()
]
DB_PATH = os.environ.get("ETF_MIRROR_DB", "/root/ai-dca/data/etf-pcf-mirror.db")
PORT = int(os.environ.get("ETF_MIRROR_PORT", "8082"))
REFRESH_INTERVAL = int(os.environ.get("ETF_MIRROR_INTERVAL", "300"))
UPSTREAM_TIMEOUT = float(os.environ.get("ETF_MIRROR_TIMEOUT", "30"))
PROBE_TIMEOUT = float(os.environ.get("ETF_MIRROR_PROBE_TIMEOUT", "6"))  # 单个候选 IP 握手探测超时（覆盖跨境 3~8s）
STALE_TRIGGER = REFRESH_INTERVAL * 2  # 超过该年龄的缓存命中后触发后台刷新

# 与 worker 侧 TARGET_CODES 一致（8 只深市 + 5 只沪市）
TARGET_CODES = [
    "159501", "159509", "159513", "159632", "159659",
    "159660", "159696", "159941",
    "513100", "513110", "513300", "513390", "513870",
]

_json_headers = {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
}

_state = {"last_sync": None, "last_sync_ok": None, "last_error": None,
          "best_ip": None, "ip_probe": None, "ip_selected_at": None}
_state_lock = threading.Lock()


def _now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _connect():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.execute(
        """CREATE TABLE IF NOT EXISTS mirror (
            kind TEXT NOT NULL,
            key TEXT NOT NULL,
            payload TEXT NOT NULL,
            status INTEGER NOT NULL,
            fetched_at TEXT NOT NULL,
            PRIMARY KEY (kind, key)
        )"""
    )
    return conn


def db_get(kind, key):
    with _connect() as conn:
        row = conn.execute(
            "SELECT payload, status, fetched_at FROM mirror WHERE kind=? AND key=?",
            (kind, key),
        ).fetchone()
    return row


def db_put(kind, key, payload, status):
    with _connect() as conn:
        conn.execute(
            """INSERT INTO mirror (kind, key, payload, status, fetched_at)
               VALUES (?,?,?,?,?)
               ON CONFLICT(kind, key) DO UPDATE SET
                 payload=excluded.payload, status=excluded.status,
                 fetched_at=excluded.fetched_at""",
            (kind, key, payload, status, _now_iso()),
        )
        conn.commit()


class PinnedHTTPSConnection(http.client.HTTPSConnection):
    """连固定 IP、SNI/Host 用真实域名的 HTTPS 连接。"""

    def __init__(self, host, pinned_ip, timeout):
        super().__init__(host, 443, timeout=timeout)
        self._pinned_ip = pinned_ip

    def connect(self):
        self.sock = self._create_connection((self._pinned_ip, self.port), timeout=self.timeout)
        if self._tunnel_host:
            self._tunnel()
        self.sock = self._context.wrap_socket(self.sock, server_hostname=self.host)


_tls = threading.local()
_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36"


def _upstream_host():
    return urllib.parse.urlparse(UPSTREAM).hostname or "api.freebacktrack.tech"


# ---- IP 优选（每轮后台同步重选，不固定） ----------------------------------
_best_ip_lock = threading.Lock()
_best_ip = None  # 当前优选 IP；每轮后台同步前重选，不固定


def _candidate_ips():
    """候选 IP 池：域名实时解析到的 A 记录 ∪ 环境变量静态池（去重，仅 IPv4）。"""
    ips = []
    host = _upstream_host()
    try:
        for info in socket.getaddrinfo(host, 443, socket.AF_INET, socket.SOCK_STREAM):
            ip = info[4][0]
            if ip not in ips:
                ips.append(ip)
    except Exception:
        pass
    for ip in UPSTREAM_IPS:
        if ip not in ips:
            ips.append(ip)
    return ips


def _probe_ip(ip):
    """对候选 IP 做一次 TCP+TLS 握手，返回耗时秒；失败返回 None。

    与真实回源同构（pin IP、SNI/Host 用真实域名），因此握手耗时即该入口的真实成本。
    """
    host = _upstream_host()
    sock = None
    t0 = time.time()
    try:
        sock = socket.create_connection((ip, 443), timeout=PROBE_TIMEOUT)
        ctx = ssl.create_default_context()
        with ctx.wrap_socket(sock, server_hostname=host):
            return time.time() - t0
    except Exception:
        return None
    finally:
        try:
            if sock is not None:
                sock.close()
        except Exception:
            pass


def select_best_ip(exclude=None):
    """并发探测候选池，返回握手最快的 IP（优选）。

    全部不可达时退回候选池首个（宁可用一个也不要断）。exclude 用于连接层失败后的
    即时重选，避开刚失败的 IP。
    """
    cands = [ip for ip in _candidate_ips() if ip != exclude] or _candidate_ips()
    results = []
    with ThreadPoolExecutor(max_workers=min(8, len(cands) or 1)) as pool:
        futs = {ip: pool.submit(_probe_ip, ip) for ip in cands}
        for ip, fut in futs.items():
            try:
                lat = fut.result()
            except Exception:
                lat = None
            if lat is not None:
                results.append((lat, ip))
    results.sort()
    best = results[0][1] if results else (cands[0] if cands else None)
    probe_summary = ", ".join(f"{ip}={lat * 1000:.0f}ms" for lat, ip in results) or "all-unreachable"
    with _state_lock:
        _state["ip_probe"] = probe_summary
    return best


def refresh_best_ip(exclude=None):
    """重选优选 IP 并更新全局（每轮后台同步前调用，保证“每次都优选、不固定”）。"""
    global _best_ip
    ip = select_best_ip(exclude=exclude)
    if ip:
        with _best_ip_lock:
            prev = _best_ip
            _best_ip = ip
        with _state_lock:
            _state["best_ip"] = ip
            _state["ip_selected_at"] = _now_iso()
            probe = _state.get("ip_probe")
        if ip != prev:
            print(f"[mirror] 优选 IP: {prev} -> {ip} ({probe})", flush=True)
    return ip


def _current_ip():
    """当前应使用的 IP：优先用最近一次优选结果；未优选过则退回静态池首个。"""
    with _best_ip_lock:
        if _best_ip:
            return _best_ip
    return UPSTREAM_IPS[0] if UPSTREAM_IPS else _upstream_host()


def _get_conn():
    """线程内复用连接（跨境 TLS 握手 3~8s，复用后仅首请求付出成本）。

    连接 pin 到当前优选 IP；优选结果变化时自动丢弃旧连接重建。
    """
    target_ip = _current_ip()
    conn = getattr(_tls, "conn", None)
    if conn is not None and getattr(_tls, "ip", None) != target_ip:
        try:
            conn.close()
        except Exception:
            pass
        conn = None
    if conn is None:
        conn = PinnedHTTPSConnection(_upstream_host(), target_ip, UPSTREAM_TIMEOUT)
        _tls.conn = conn
        _tls.ip = target_ip
    return conn


def _request_once(path):
    conn = _get_conn()
    conn.request("GET", path, headers={"accept": "application/json", "user-agent": _UA, "host": _upstream_host()})
    resp = conn.getresponse()
    body = resp.read().decode("utf-8", "replace")
    return resp.status, body


def fetch_upstream(path):
    """回源 CF worker，返回 (status, body_text)。

    每轮后台同步前已做 IP 优选（见 refresh_best_ip），这里只负责连接复用；
    连接层失败时丢弃连接并立即重新优选（避开刚失败的 IP）重试一次，再失败抛异常。
    注意 CF 对 python 默认 UA 返回 1010 拒绝，必须带浏览器 UA。
    """
    last_err = None
    for attempt in range(2):
        try:
            return _request_once(path)
        except Exception as e:
            last_err = e
            failed_ip = getattr(_tls, "ip", None)
            try:
                _tls.conn.close()
            except Exception:
                pass
            _tls.conn = None
            if attempt == 0:
                # 连接层失败：即时重新优选（避开刚失败的 IP），下次 _get_conn 用新 IP
                refresh_best_ip(exclude=failed_ip)
    raise RuntimeError(f"upstream fetch failed: {last_err}")


def refresh_one(path, kind, key):
    status, body = fetch_upstream(path)
    if 200 <= status < 300:  # 只缓存成功响应，失败不覆盖旧数据
        db_put(kind, key, body, status)
    return status


def refresh_loop():
    # shares latest 同时落到 date:<date> 键，供 ?date= 当日查询命中
    def refresh_shares():
        path = "/api/etf-pcf-shares"
        status, body = fetch_upstream(path)
        if not (200 <= status < 300):
            return status
        db_put("shares", "latest", body, status)
        try:
            date = json.loads(body).get("date")
            if date:
                db_put("shares", f"date:{date}", body, status)
        except Exception:
            pass
        return status

    def refresh_limit(code):
        # 无 date 版预热后，顺带把 payload 里的 date 也落到 "{code}:{date}" 键，
        # 让前端带 date 的明细请求命中缓存（否则首次必回源，跨境 3~8s）。
        status, body = fetch_upstream(f"/api/etf-pcf-limit?code={code}")
        if 200 <= status < 300:
            db_put("limit", code, body, status)
            try:
                d = json.loads(body).get("date")
                if d:
                    db_put("limit", f"{code}:{d}", body, status)
            except Exception:
                pass
        return status

    while True:
        refresh_best_ip()  # 每轮同步前重新优选 IP（不固定）
        ok, errs = 0, []
        with ThreadPoolExecutor(max_workers=4) as pool:
            futures = [("shares", pool.submit(refresh_shares))]
            futures += [(c, pool.submit(refresh_limit, c)) for c in TARGET_CODES]
            for key, fut in futures:
                try:
                    if 200 <= fut.result() < 300:
                        ok += 1
                    else:
                        errs.append(f"{key}:http")
                except Exception as e:
                    errs.append(f"{key}:{e}"[:120])
        with _state_lock:
            _state["last_sync"] = _now_iso()
            _state["last_sync_ok"] = ok
            _state["last_error"] = "; ".join(errs) if errs else None
        print(f"[mirror] sync ok={ok}/{len(futures)} errs={_state['last_error']}", flush=True)
        time.sleep(REFRESH_INTERVAL)


_background_refresh_lock = threading.Lock()


def trigger_background_refresh():
    """缓存命中但偏旧时，异步触发一次刷新（stale-while-revalidate）。"""
    if _background_refresh_lock.acquire(blocking=False):
        threading.Thread(target=_bg_refresh_once, daemon=True).start()


def _bg_refresh_once():
    try:
        refresh_best_ip()  # 后台补刷前也重新优选 IP（不固定）
        refresh_one("/api/etf-pcf-shares", "shares", "latest")
        for code in TARGET_CODES:
            refresh_one(f"/api/etf-pcf-limit?code={code}", "limit", code)
    finally:
        _background_refresh_lock.release()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, status, body_text):
        data = body_text.encode("utf-8")
        self.send_response(status)
        for k, v in _json_headers.items():
            self.send_header(k, v)
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _not_found(self):
        self._send(404, json.dumps({"error": "Not found"}))

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("access-control-allow-origin", "*")
        self.send_header("access-control-allow-methods", "GET, POST, OPTIONS")
        self.send_header("content-length", "0")
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(parsed.query)
        try:
            if parsed.path == "/health":
                with _state_lock:
                    snap = dict(_state)
                self._send(200, json.dumps({"ok": True, "service": "etf-shares-mirror", **snap}))
            elif parsed.path == "/etf-pcf-shares":
                self._serve("shares", params)
            elif parsed.path == "/etf-pcf-limit":
                self._serve("limit", params)
            else:
                self._not_found()
        except BrokenPipeError:
            pass
        except Exception as e:
            self._send(502, json.dumps({"error": "mirror_error", "detail": str(e)[:200]}))

    def _serve(self, kind, params):
        # 组装缓存键（与回源路径保持一致）
        if kind == "shares":
            date_vals = params.get("date") or ["latest"]
            if len(date_vals) > 1:
                return self._send(400, json.dumps({"error": "duplicate_query_param", "reason": "duplicate_query_param", "date": date_vals[0]}))
            date = date_vals[0]
            key = "latest" if date == "latest" else f"date:{date}"
            upstream_path = "/api/etf-pcf-shares" if date == "latest" else f"/api/etf-pcf-shares?date={urllib.parse.quote(date)}"
        else:
            codes = params.get("code") or []
            if len(codes) != 1:
                return self._send(400, json.dumps({"error": "missing_code", "reason": "missing_code"}))
            code = codes[0]
            date_vals = params.get("date") or [None]
            date = date_vals[0]
            key = code if date is None else f"{code}:{date}"
            q = f"code={urllib.parse.quote(code)}" + (f"&date={urllib.parse.quote(date)}" if date else "")
            upstream_path = f"/api/etf-pcf-limit?{q}"

        row = db_get(kind, key)
        if row is not None:
            payload, status, fetched_at = row
            # 命中但偏旧（后台刷新失败过）：先返回旧数据，同时异步补刷
            try:
                age = time.time() - datetime.strptime(fetched_at, "%Y-%m-%dT%H:%M:%SZ").timestamp()
            except Exception:
                age = 0
            if age > STALE_TRIGGER:
                trigger_background_refresh()
            return self._send(status if 200 <= status < 300 else 200, payload)

        # 未命中：同步回源 CF 并落库（?date= 历史 / 非目标 code 等）
        try:
            status, body = fetch_upstream(upstream_path)
            if 200 <= status < 300:
                db_put(kind, key, body, status)
            self._send(status, body)
        except Exception as e:
            # 回源失败且无缓存：镜像层不兜底编造，透传网关错误
            self._send(502, json.dumps({"error": "upstream_unavailable", "detail": str(e)[:200]}))

    def log_message(self, fmt, *args):
        print(f"[mirror] {self.address_string()} {fmt % args}", flush=True)


def main():
    _connect()  # 预建表
    refresh_best_ip()  # 启动即优选一次，首个请求也走优选 IP
    t = threading.Thread(target=refresh_loop, daemon=True)
    t.start()
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"[mirror] listening on 127.0.0.1:{PORT}, db={DB_PATH}, upstream={UPSTREAM}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
