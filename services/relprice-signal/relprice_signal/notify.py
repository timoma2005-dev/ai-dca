"""Reuse the existing internal-sync credential via process environment only."""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request

from . import data  # establishes the sibling market-collector import path
from .rules import DataUnavailable
from market_collector.cf_ip_selection import prepare, _PinnedHandler


def notify(config, payload):
    token = os.environ.get("INTERNAL_SYNC_TOKEN", "")
    if not token:
        raise DataUnavailable("notify_internal_auth_unavailable")
    url = config["notify_url"]
    if not url.startswith("https://"):
        raise DataUnavailable("notify_requires_https")
    request = urllib.request.Request(url, data=json.dumps(payload, allow_nan=False).encode(),
                                     headers={"Content-Type": "application/json", "User-Agent": "ai-dca-relprice/1.0",
                                              "Authorization": "Bearer " + token}, method="POST")
    # Reuse the repository's bounded IPv4/TLS selector. Keep hostname/SNI/Host
    # and certificate verification; never retry a possibly-sent POST. The
    # HTTPS-only adapter is shared with market-collector, while redirects and
    # environment proxies are explicitly disabled for this credentialed call.
    os.environ.setdefault("CF_UPSTREAM_IP_SELECTION_ENABLED", "1")
    ip = prepare(url, timeout=6)
    handlers = [urllib.request.ProxyHandler({}), NoRedirect()]
    if ip:
        parsed = urllib.parse.urlsplit(url)
        handlers.append(_PinnedHandler((parsed.hostname, parsed.port or 443), ip, {"connected": False}))
    opener = urllib.request.build_opener(*handlers)
    try:
        with opener.open(request, timeout=30) as response:
            result = json.loads(response.read(100_000))
    except urllib.error.HTTPError as error:
        # Never expose headers, tokens, channel credentials, or provider payloads.
        raise DataUnavailable("notify_http_" + str(error.code)) from None
    except (OSError, urllib.error.URLError):
        raise DataUnavailable("notify_transport_unavailable") from None
    if not result.get("ok"):
        raise DataUnavailable("notify_not_accepted")
    return result


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise DataUnavailable("notify_redirect_refused")
