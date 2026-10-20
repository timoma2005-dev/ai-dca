"""Opt-in, origin-scoped IPv4 selection for Worker requests (standard library).

Connections deliberately close after each request; there is no connection pool.
DNS/probe workers are daemon threads so a stuck resolver cannot block shutdown.
"""
from __future__ import annotations

import http.client
import ipaddress
import math
import os
import queue
import socket
import ssl
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import warnings

_DEFAULT_IPS = '104.21.38.17,172.67.217.77'
_DEFAULT_HOSTS = 'api.freebacktrack.tech,fast.freebacktrack.tech'
_states = {}
_states_lock = threading.Lock()


def _number(name, default):
    try:
        value = float(os.getenv(name, str(default)))
        if math.isfinite(value) and value > 0:
            return value
    except ValueError:
        pass
    warnings.warn(f'{name}: invalid value; using {default}', RuntimeWarning)
    return default


def _target(url):
    if os.getenv('CF_UPSTREAM_IP_SELECTION_ENABLED', '0') != '1':
        return None
    parsed = urllib.parse.urlsplit(url)
    if parsed.username is not None or parsed.password is not None:
        raise ValueError('Worker URL must not contain credentials')
    hosts = {h.strip().lower() for h in os.getenv('CF_UPSTREAM_HOSTS', _DEFAULT_HOSTS).split(',')}
    if parsed.scheme != 'https' or parsed.hostname not in hosts:
        return None
    try:
        ipaddress.ip_address(parsed.hostname)
        return None
    except ValueError:
        pass
    return parsed.hostname, parsed.port or 443


def _ipv4(values):
    result = []
    for value in values:
        try:
            ip = str(ipaddress.IPv4Address(value.strip()))
        except (ValueError, AttributeError):
            continue
        if ip not in result:
            result.append(ip)
    return result


def _async_call(fn, output):
    def run():
        try:
            output.put((True, fn()))
        except Exception as exc:
            output.put((False, exc))
    threading.Thread(target=run, daemon=True).start()


def _candidates(host, port, deadline):
    output = queue.Queue()
    _async_call(lambda: socket.getaddrinfo(host, port, socket.AF_INET, socket.SOCK_STREAM), output)
    records = []
    try:
        ok, value = output.get(timeout=max(0, deadline - time.monotonic()))
        if ok:
            records = [record[4][0] for record in value]
    except queue.Empty:
        pass
    return _ipv4(records + os.getenv('CF_UPSTREAM_IPS', _DEFAULT_IPS).split(','))[:16]


def _probe(host, port, ip, timeout):
    started = time.monotonic()
    with socket.create_connection((ip, port), timeout=timeout) as sock:
        sock.settimeout(max(.001, timeout - (time.monotonic() - started)))
        with ssl.create_default_context().wrap_socket(sock, server_hostname=host):
            return time.monotonic() - started


class _State:
    def __init__(self):
        self.lock = threading.Lock()
        self.ip = None
        self.selected_at = -math.inf
        self.degraded = False


def _select(target, deadline, exclude=None):
    with _states_lock:
        state = _states.setdefault(target, _State())
    if not state.lock.acquire(timeout=max(0, deadline - time.monotonic())):
        return None
    try:
        if (time.monotonic() - state.selected_at < _number('CF_UPSTREAM_RESELECT_INTERVAL', 300)
                and (exclude is None or state.ip != exclude)):
            return state.ip
        round_end = min(deadline, time.monotonic() + _number('CF_UPSTREAM_PROBE_TIMEOUT', 6))
        candidates = [ip for ip in _candidates(*target, round_end) if ip != exclude]
        jobs = queue.Queue()
        results = queue.Queue()
        for ip in candidates:
            jobs.put(ip)

        def worker():
            while time.monotonic() < round_end:
                try:
                    ip = jobs.get_nowait()
                except queue.Empty:
                    return
                try:
                    latency = _probe(*target, ip, max(.001, round_end - time.monotonic()))
                    results.put((ip, latency))
                except (OSError, ValueError):
                    results.put((ip, None))

        threads = [threading.Thread(target=worker, daemon=True) for _ in range(min(8, len(candidates)))]
        for thread in threads:
            thread.start()
        ranked = []
        for _ in candidates:
            try:
                ip, latency = results.get(timeout=max(0, round_end - time.monotonic()))
            except queue.Empty:
                break
            if latency is not None:
                ranked.append((latency, ip))
        selected = min(ranked)[1] if ranked else (candidates[0] if candidates else None)
        # A failed-route retry needs a verified alternative; otherwise use DNS.
        if exclude and not ranked:
            return None
        state.ip = selected
        state.degraded = not bool(ranked)
        state.selected_at = time.monotonic()
        return selected
    finally:
        state.lock.release()


def prepare(url, *, timeout=None):
    """Warm the shared TTL cache; disabled/unlisted URLs do no DNS or probing."""
    target = _target(url)
    if target:
        return _select(target, time.monotonic() + min(
            _number('CF_UPSTREAM_PROBE_TIMEOUT', 6), timeout if timeout is not None else math.inf))
    return None


class _PinnedConnection(http.client.HTTPSConnection):
    def __init__(self, host, *, ip, phase, **kwargs):
        super().__init__(host, **kwargs)
        self._ip = ip
        self._phase = phase

    def connect(self):
        sock = socket.create_connection((self._ip, self.port), self.timeout, self.source_address)
        try:
            self.sock = self._context.wrap_socket(sock, server_hostname=self.host)
        except BaseException:
            sock.close()
            raise
        # Conservative: from this point http.client can send headers/body.
        self._phase['connected'] = True


class _PinnedHandler(urllib.request.HTTPSHandler):
    def __init__(self, target, ip, phase):
        super().__init__(context=ssl.create_default_context())
        self.target, self.ip, self.phase = target, ip, phase

    def https_open(self, request):
        if _target(request.full_url) != self.target:
            return self.do_open(http.client.HTTPSConnection, request, context=self._context)
        request.add_unredirected_header('Host', urllib.parse.urlsplit(request.full_url).netloc)
        def connection(host, **kwargs):
            return _PinnedConnection(host, ip=self.ip, phase=self.phase, **kwargs)
        return self.do_open(connection, request, context=self._context)


class _SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        redirected = super().redirect_request(req, fp, code, msg, headers, newurl)
        if redirected and urllib.parse.urlsplit(req.full_url)[:2] != urllib.parse.urlsplit(newurl)[:2]:
            for name in list(redirected.headers):
                if name.lower() in {'authorization', 'cookie', 'x-market-collector-token', 'host'}:
                    redirected.remove_header(name)
        return redirected


def _open_pinned(request, timeout, target, ip, phase):
    # No environment proxy on the pin path: it would bypass the selected IP.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}),
                                         _PinnedHandler(target, ip, phase), _SafeRedirect())
    try:
        return opener.open(request, timeout=timeout)
    except urllib.error.URLError:
        raise
    except (OSError, http.client.HTTPException) as exc:
        raise urllib.error.URLError(exc) from exc


def open_url(request, timeout=socket._GLOBAL_DEFAULT_TIMEOUT):
    url = request.full_url if isinstance(request, urllib.request.Request) else request
    target = _target(url)
    if not target:
        return urllib.request.urlopen(request, timeout=timeout)
    budget = socket.getdefaulttimeout() if timeout is socket._GLOBAL_DEFAULT_TIMEOUT else timeout
    deadline = time.monotonic() + (budget if budget is not None else 60)
    ip = _select(target, deadline)
    if not ip:
        return urllib.request.urlopen(request, timeout=max(.001, deadline - time.monotonic()))
    phase = {'connected': False}
    try:
        return _open_pinned(request, max(.001, deadline - time.monotonic()), target, ip, phase)
    except urllib.error.HTTPError:
        raise
    except (OSError, urllib.error.URLError, http.client.HTTPException) as exc:
        method = request.get_method() if isinstance(request, urllib.request.Request) else 'GET'
        if (phase['connected'] and method not in {'GET', 'HEAD'}) or time.monotonic() >= deadline:
            if isinstance(exc, (OSError, http.client.HTTPException)) and not isinstance(exc, urllib.error.URLError):
                raise urllib.error.URLError(exc) from exc
            raise
        alternative = _select(target, deadline, exclude=ip)
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise urllib.error.URLError(TimeoutError('Worker request deadline exceeded')) from exc
        if alternative:
            return _open_pinned(request, remaining, target, alternative, {'connected': False})
        return urllib.request.urlopen(request, timeout=remaining)
