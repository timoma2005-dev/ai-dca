"""蛋卷基金直连客户端：基金详情 / 历史净值 / OTC 快照拼装。

CN 域名全本地化后，净值与场外基金数据不再经过 CF workers，
直接从 danjuanfunds.com 采集（与小程序 danjuanNavClient 同源）。
"""
from __future__ import annotations

import json
import urllib.request
from typing import Any, Callable

DANJUAN_DETAIL_URL = "https://danjuanfunds.com/djapi/fund/{code}"
DANJUAN_NAV_HISTORY_URL = "https://danjuanfunds.com/djapi/fund/nav/history/{code}"

_UA_HEADERS = {
    "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    "accept": "application/json",
}

FetchJson = Callable[[str, float], dict[str, Any]]


def _fetch_json(url: str, timeout: float) -> dict[str, Any]:
    # 经 netutil：直连优先，被拦截时经机器级出口代理重试（非 CF workers）。
    from .netutil import fetch_url

    raw = fetch_url(url, timeout)
    payload = json.loads(raw.decode("utf-8", "replace"))
    if not isinstance(payload, dict):
        raise ValueError(f"danjuan response is not an object: {url}")
    return payload


def _positive_float(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number != number or number <= 0:
        return None
    return number


def _float(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number == number else None


def _normalize_code(code: Any) -> str:
    text = str(code or "").strip()
    return text if text.isdigit() and len(text) == 6 else ""


def fetch_fund_detail(
    code: str,
    timeout: float = 10.0,
    fetch_json: FetchJson = _fetch_json,
) -> dict[str, Any] | None:
    """/djapi/fund/{code} 的 data 节点（含 fund_derived / type_desc / 销售状态）。"""
    normalized = _normalize_code(code)
    if not normalized:
        return None
    try:
        payload = fetch_json(DANJUAN_DETAIL_URL.format(code=normalized), timeout)
    except Exception:
        return None
    data = payload.get("data")
    return data if isinstance(data, dict) else None


def fetch_nav_history(
    code: str,
    size: int = 700,
    timeout: float = 10.0,
    fetch_json: FetchJson = _fetch_json,
) -> list[dict[str, Any]]:
    """历史净值升序序列 [{date, nav}]；danjuan 返回按日期降序，这里过滤后升序。"""
    normalized = _normalize_code(code)
    if not normalized:
        return []
    size = max(1, min(int(size or 1), 3000))
    url = DANJUAN_NAV_HISTORY_URL.format(code=normalized) + f"?size={size}&page=1"
    try:
        payload = fetch_json(url, timeout)
    except Exception:
        return []
    items = ((payload.get("data") or {}).get("items")) or []
    series: list[dict[str, Any]] = []
    for item in items:
        nav_date = str(item.get("date") or "")[:10]
        nav = _positive_float(item.get("nav"))
        if not nav_date or nav is None:
            continue
        series.append({"date": nav_date, "nav": nav})
    series.sort(key=lambda row: row["date"])
    return series


def fund_kind(detail: dict[str, Any]) -> tuple[str, str]:
    """由 type_desc / fd_type 推断 (fundKind, fundType 文案)。"""
    type_desc = str(detail.get("type_desc") or "").strip()
    if not type_desc:
        fd_type = str(detail.get("fd_type") or "").strip()
        type_desc = {"11": "QDII-股票", "9": "QDII"}.get(fd_type, "场外基金")
    if "QDII" in type_desc.upper():
        return "qdii", type_desc
    return "otc", type_desc


def build_otc_item(detail: dict[str, Any], collected_at: str) -> dict[str, Any] | None:
    """把 danjuan 详情拼成 otc-latest / fund-metrics 的 item 结构。

    字段与旧 worker fund-metrics 的 danjuan 兜底保持同构，
    ``fallback`` 标注为 danjuan-direct 以便区分数据路径。
    """
    code = _normalize_code(detail.get("fd_code"))
    if not code:
        return None
    derived = detail.get("fund_derived") or {}
    unit_nav = _positive_float(derived.get("unit_nav"))
    if unit_nav is None:
        return None
    nav_date = str(derived.get("end_date") or "")[:10] or None
    growth = _float(derived.get("nav_growth"))
    previous_nav = None
    if growth is not None and growth > -100:
        previous_nav = round(unit_nav / (1 + growth / 100), 4)
    kind, type_desc = fund_kind(detail)

    def _pct(key: str) -> float | None:
        value = _float(derived.get(key))
        return round(value, 4) if value is not None else None

    return {
        "code": code,
        "symbol": code,
        "name": str(detail.get("fd_name") or code),
        "fullName": str(detail.get("fd_full_name") or detail.get("fd_name") or code),
        "fundKind": kind,
        "fundType": type_desc,
        "fundTypeCode": str(detail.get("fd_type") or ""),
        "market": "cn",
        "marketState": "CLOSED",
        "close": unit_nav,
        "currentPrice": unit_nav,
        "latestNav": unit_nav,
        "latestNavDate": nav_date,
        "previousClose": previous_nav,
        "previousNav": previous_nav,
        "change": round(unit_nav - previous_nav, 4) if previous_nav is not None else None,
        "changePercent": round(growth, 4) if growth is not None else None,
        "return1m": _pct("nav_grl1m"),
        "return3m": _pct("nav_grl3m"),
        "return6m": _pct("nav_grl6m"),
        "return1y": _pct("nav_grl1y"),
        "returnBase": _pct("nav_grbase"),
        "ytdReturn": _pct("nav_grlty"),
        "iopv": None,
        "volume": None,
        "turnover": None,
        "suspended": False,
        "session": "otc",
        "asOf": collected_at,
        "updatedAt": collected_at,
        "fallback": "danjuan-direct",
        "source": "danjuan",
    }
