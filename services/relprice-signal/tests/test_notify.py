from __future__ import annotations

import json
import os
import unittest
from unittest.mock import patch
import urllib.request

from relprice_signal.notify import NoRedirect, notify
from relprice_signal.rules import DataUnavailable
from market_collector.cf_ip_selection import _PinnedHandler


class NotifyTests(unittest.TestCase):
    def test_pinned_transport_preserves_no_proxy_no_redirect_and_service_identity(self):
        class Reply:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self, size): return json.dumps({'ok': True, 'dry_run': True}).encode()
        class Opener:
            def open(self, request, timeout):
                self.request = request
                return Reply()
        opener = Opener()
        with patch.dict(os.environ, {'INTERNAL_SYNC_TOKEN': 'unit-test-only'}, clear=False), \
             patch('relprice_signal.notify.prepare', return_value='104.21.38.17'), \
             patch('relprice_signal.notify.urllib.request.build_opener', return_value=opener) as build:
            result = notify({'notify_url': 'https://api.freebacktrack.tech/api/notify/internal/relprice-signal'}, {'dry_run': True})
        self.assertTrue(result['ok'])
        handlers = build.call_args.args
        self.assertTrue(any(isinstance(h, NoRedirect) for h in handlers))
        self.assertTrue(any(isinstance(h, _PinnedHandler) for h in handlers))
        self.assertTrue(any(isinstance(h, urllib.request.ProxyHandler) and h.proxies == {} for h in handlers))
        self.assertEqual(opener.request.get_header('User-agent'), 'ai-dca-relprice/1.0')

    def test_unknown_post_outcome_never_retries(self):
        class Opener:
            calls = 0
            def open(self, *args, **kwargs):
                self.calls += 1
                raise TimeoutError()
        opener = Opener()
        with patch.dict(os.environ, {'INTERNAL_SYNC_TOKEN': 'unit-test-only'}, clear=False), \
             patch('relprice_signal.notify.prepare', return_value=None), \
             patch('relprice_signal.notify.urllib.request.build_opener', return_value=opener):
            with self.assertRaisesRegex(DataUnavailable, 'notify_transport_unavailable'):
                notify({'notify_url': 'https://api.freebacktrack.tech/api/notify/internal/relprice-signal'}, {})
        self.assertEqual(opener.calls, 1)

    def test_missing_auth_fails_before_any_network_selection(self):
        with patch.dict(os.environ, {}, clear=True), patch('relprice_signal.notify.prepare') as prepare:
            with self.assertRaisesRegex(DataUnavailable, 'notify_internal_auth_unavailable'):
                notify({'notify_url': 'https://api.freebacktrack.tech/api/notify/internal/relprice-signal'}, {})
            prepare.assert_not_called()
