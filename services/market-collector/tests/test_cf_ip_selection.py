import concurrent.futures
import io
import os
import socket
import ssl
import threading
import unittest
import urllib.error
import urllib.request
from unittest.mock import Mock, patch
from market_collector import cf_ip_selection as cf

URL = 'https://api.freebacktrack.tech:8443/path?q=1'
TARGET = ('api.freebacktrack.tech', 8443)


class SelectionTests(unittest.TestCase):
    def setUp(self):
        cf._states.clear()
        for patcher in [patch.dict(os.environ, {'CF_UPSTREAM_IP_SELECTION_ENABLED': '1', 'CF_UPSTREAM_IPS': '104.21.38.17,172.67.217.77', 'CF_UPSTREAM_HOSTS': 'api.freebacktrack.tech,fast.freebacktrack.tech', 'CF_UPSTREAM_PROBE_TIMEOUT': '6', 'CF_UPSTREAM_RESELECT_INTERVAL': '300'})]:
            patcher.start()
            self.addCleanup(patcher.stop)
        p = patch.object(cf.socket, 'getaddrinfo', return_value=[])
        self.dns = p.start()
        self.addCleanup(p.stop)
        p = patch.object(cf, '_probe', side_effect=lambda h, p, ip, t: 1 if ip == '104.21.38.17' else 2)
        self.probe = p.start()
        self.addCleanup(p.stop)

    def test_candidates(self):
        self.dns.return_value = [(socket.AF_INET, 1, 6, '', ('1.2.3.4', 443)), (socket.AF_INET, 1, 6, '', ('104.21.38.17', 443))]
        with patch.dict(os.environ, {'CF_UPSTREAM_IPS': '104.21.38.17,::1,bad,1.2.3.4,172.67.217.77'}):
            self.assertEqual(cf._candidates(*TARGET, cf.time.monotonic() + 1), ['1.2.3.4', '104.21.38.17', '172.67.217.77'])
        self.assertEqual(self.dns.call_args.args[2], socket.AF_INET)

    def test_all_fail_fallback(self):
        self.dns.side_effect = OSError('dns')
        self.probe.side_effect = OSError('tls')
        self.assertEqual(cf.prepare(URL), '104.21.38.17')
        self.assertTrue(cf._states[TARGET].degraded)

    def test_ttl_and_origin(self):
        with patch.object(cf.time, 'monotonic', return_value=100):
            self.assertEqual(cf.prepare(URL), '104.21.38.17')
            cf.prepare(URL)
        self.assertEqual(self.probe.call_count, 2)
        with patch.object(cf.time, 'monotonic', return_value=401):
            cf.prepare(URL)
            cf.prepare('https://fast.freebacktrack.tech/')
        self.assertEqual(self.probe.call_count, 6)

    def test_singleflight(self):
        entered, release = threading.Event(), threading.Event()
        def probe(*args):
            entered.set()
            release.wait(2)
            return 1
        self.probe.side_effect = probe
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            futures = [pool.submit(cf.prepare, URL) for _ in range(8)]
            self.assertTrue(entered.wait(1))
            release.set()
            self.assertTrue(all(f.result() for f in futures))
        self.assertEqual(self.dns.call_count, 1)
        self.assertEqual(self.probe.call_count, 2)

    def test_bypass_zero_probe(self):
        with patch.object(cf.urllib.request, 'urlopen', return_value='plain') as plain:
            for url in ['http://api.freebacktrack.tech/', 'https://other.test/', 'https://104.21.38.17/']:
                self.assertIsNone(cf.prepare(url))
                self.assertEqual(cf.open_url(url, timeout=2), 'plain')
            with patch.dict(os.environ, {'CF_UPSTREAM_IP_SELECTION_ENABLED': '0'}):
                self.assertIsNone(cf.prepare(URL))
                cf.open_url(URL, timeout=2)
            self.assertEqual(plain.call_count, 4)
        self.dns.assert_not_called()
        self.probe.assert_not_called()

    def test_empty_pool(self):
        with patch.dict(os.environ, {'CF_UPSTREAM_IPS': 'bad,::1'}), patch.object(cf.urllib.request, 'urlopen', return_value='plain'):
            self.assertEqual(cf.open_url(URL, timeout=2), 'plain')
        self.probe.assert_not_called()

    def test_failure_changes_ip(self):
        with patch.object(cf, '_open_pinned', side_effect=[urllib.error.URLError('connect'), 'ok']) as pinned:
            self.assertEqual(cf.open_url(URL, timeout=2), 'ok')
        self.assertEqual([c.args[3] for c in pinned.call_args_list], ['104.21.38.17', '172.67.217.77'])

    def test_single_ip_retry_dns(self):
        with patch.dict(os.environ, {'CF_UPSTREAM_IPS': '104.21.38.17'}), patch.object(cf, '_open_pinned', side_effect=urllib.error.URLError('connect')) as pinned, patch.object(cf.urllib.request, 'urlopen', return_value='dns') as plain:
            self.assertEqual(cf.open_url(URL, timeout=2), 'dns')
        pinned.assert_called_once()
        plain.assert_called_once()

    def test_http_error_identical(self):
        error = urllib.error.HTTPError(URL, 503, 'busy', {}, io.BytesIO())
        with patch.object(cf, '_open_pinned', side_effect=error) as pinned:
            with self.assertRaises(urllib.error.HTTPError) as caught:
                cf.open_url(URL, timeout=2)
        self.assertIs(caught.exception, error)
        pinned.assert_called_once()

    def test_post_only_retries_before_write(self):
        request = urllib.request.Request(URL, data=b'{}', method='POST')
        for connected, expected in [(False, 2), (True, 1)]:
            cf._states.clear()
            def fail(req, timeout, target, ip, phase):
                phase['connected'] = connected
                raise urllib.error.URLError('disconnect')
            with patch.object(cf, '_open_pinned', side_effect=fail) as pinned:
                with self.assertRaises(urllib.error.URLError):
                    cf.open_url(request, timeout=2)
                self.assertEqual(pinned.call_count, expected)

    def test_strict_tls_hostname(self):
        context = ssl.create_default_context()
        sock = Mock()
        with patch.object(cf.socket, 'create_connection', return_value=sock) as connect, patch.object(context, 'wrap_socket') as wrap:
            cf._PinnedConnection('api.freebacktrack.tech:8443', ip='1.2.3.4', phase={}, context=context, timeout=2).connect()
            connect.assert_called_once_with(('1.2.3.4', 8443), 2, None)
            wrap.assert_called_once_with(sock, server_hostname='api.freebacktrack.tech')
        self.assertTrue(context.check_hostname)
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)

    def test_local_opener_http_error(self):
        error = urllib.error.HTTPError(URL, 403, 'denied', {}, io.BytesIO())
        opener = Mock()
        opener.open.side_effect = error
        with patch.object(cf.urllib.request, 'build_opener', return_value=opener):
            with self.assertRaises(urllib.error.HTTPError) as caught:
                cf._open_pinned(URL, 2, TARGET, '1.2.3.4', {})
        self.assertIs(caught.exception, error)

    def test_redirect_strips_credentials(self):
        request = urllib.request.Request(URL, headers={'Authorization': 'secret', 'Cookie': 'secret', 'X-market-collector-token': 'secret'})
        redirect = cf._SafeRedirect().redirect_request(request, None, 302, '', {}, 'https://other.test/')
        self.assertEqual(redirect.headers, {})

    def test_config_and_url_validation(self):
        with patch.dict(os.environ, {'CF_UPSTREAM_PROBE_TIMEOUT': 'nan'}), self.assertWarns(RuntimeWarning):
            self.assertEqual(cf._number('CF_UPSTREAM_PROBE_TIMEOUT', 6), 6)
        with self.assertRaises(ValueError):
            cf.prepare('https://user:pass@api.freebacktrack.tech/')


class IntegrationTests(unittest.TestCase):
    def test_xueqiu_worker_only_and_cookie_isolation(self):
        from market_collector import xueqiu
        response = Mock()
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock()
        response.read.return_value = b'{"results":{}}'
        with patch.object(cf, 'open_url', return_value=response) as pinned, patch.object(xueqiu.urllib.request, 'urlopen', return_value=response) as plain:
            xueqiu._fetch_worker_payload('510300', worker_url=URL, timeout_sec=2, fetch_json=xueqiu.default_fetch_json, include_raw=False, force_refresh=False)
            self.assertFalse(any(k.lower() == 'cookie' for k in pinned.call_args.args[0].headers))
            xueqiu.default_fetch_json('https://stock.xueqiu.com/test', {'cookie': 'private'}, 2)
            pinned.assert_called_once()
            plain.assert_called_once()

    def test_injected_xueqiu_fetcher_bypasses_transport(self):
        from market_collector import xueqiu
        fetch = Mock(return_value={'results': {}})
        with patch.object(cf, 'open_url') as pinned:
            xueqiu._fetch_worker_payload('510300', worker_url=URL, timeout_sec=2, fetch_json=fetch, include_raw=False, force_refresh=False)
        pinned.assert_not_called()
        fetch.assert_called_once()

    def test_publisher_injection_and_unknown_result_spool(self):
        import tempfile
        from pathlib import Path
        from market_collector.publish import build_publisher
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {'TEST_TOKEN': 'secret'}):
            config = {'output_dir': tmp, 'publisher': {'backend': 'file+worker', 'worker_url': URL, 'token_env': 'TEST_TOKEN', 'outbox_dir': tmp + '/outbox'}}
            injected = Mock(side_effect=urllib.error.URLError('unknown'))
            with patch.object(cf, 'prepare') as prepare:
                publisher = build_publisher(config, opener=injected)
                publisher.publish({'generated_at': 'now'}, {})
                prepare.assert_not_called()
            injected.assert_called_once()
            self.assertEqual(len(list(Path(tmp, 'outbox').glob('*.json'))), 1)
            with patch.object(cf, 'prepare') as prepare, patch.object(cf, 'open_url', side_effect=urllib.error.URLError('unknown')) as pinned:
                publisher = build_publisher(config)
                publisher.publish({'generated_at': 'later'}, {})
                prepare.assert_called_once_with(URL, timeout=15.0)
                pinned.assert_called_once()
            self.assertEqual(len(list(Path(tmp, 'outbox').glob('*.json'))), 2)

    def test_empty_quotes_url_never_opens(self):
        import tempfile
        from pathlib import Path
        from market_collector.product_http_server import _market_quotes_request_from_config
        with tempfile.TemporaryDirectory() as tmp, patch.object(cf, 'open_url') as pinned, patch.object(cf, 'prepare') as prepare:
            config = Path(tmp, 'config.json')
            config.write_text('{"market_api":{"worker_url":""}}')
            self.assertEqual(_market_quotes_request_from_config(str(config))(['510300']), {})
            pinned.assert_not_called()
            prepare.assert_not_called()

    def test_publisher_prepare_shares_first_post_budget(self):
        import tempfile
        from market_collector.publish import build_publisher
        clock = [100.0]
        def prepare(*args, **kwargs):
            clock[0] += 4
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {'TEST_TOKEN': 'secret'}), patch('market_collector.publish.time.monotonic', side_effect=lambda: clock[0]), patch.object(cf, 'prepare', side_effect=prepare), patch.object(cf, 'open_url', side_effect=urllib.error.URLError('offline')) as opener:
            publisher = build_publisher({'output_dir': tmp, 'publisher': {'backend': 'file+worker', 'worker_url': URL, 'token_env': 'TEST_TOKEN'}})
            publisher.publish({'generated_at': 'now'}, {})
            self.assertEqual(opener.call_args.kwargs['timeout'], 11)

    def test_probe_strict_tls_and_closes(self):
        # Capture the actual probe before replacing it; this class has no probe patch.
        context = ssl.create_default_context()
        from unittest.mock import MagicMock
        sock = MagicMock()
        sock.__enter__.return_value = sock
        tls = MagicMock()
        with patch.object(cf.socket, 'create_connection', return_value=sock), patch.object(cf.ssl, 'create_default_context', return_value=context), patch.object(context, 'wrap_socket', return_value=tls) as wrap:
            self.assertGreaterEqual(cf._probe('api.freebacktrack.tech', 443, '1.2.3.4', 2), 0)
            wrap.assert_called_once_with(sock, server_hostname='api.freebacktrack.tech')
            sock.__exit__.assert_called_once()
            tls.__exit__.assert_called_once()
        self.assertTrue(context.check_hostname)
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
