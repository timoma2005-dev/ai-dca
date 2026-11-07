"""Reuse the existing internal-sync credential via process environment only."""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

from .rules import DataUnavailable


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
    # Both loopback and upstream requests deliberately avoid inherited proxies.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        with opener.open(request, timeout=30) as response:
            result = json.loads(response.read(100_000))
    except urllib.error.HTTPError as error:
        # Never expose headers, tokens, channel credentials, or provider payloads.
        raise DataUnavailable("notify_http_" + str(error.code)) from None
    if not result.get("ok"):
        raise DataUnavailable("notify_not_accepted")
    return result


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise DataUnavailable("notify_redirect_refused")
