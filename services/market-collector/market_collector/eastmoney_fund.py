"""东方财富基金直连：F10 费率页 + 移动端基本信息（申购状态/限额）。

夜间 fund_reference 同步不再回源 CF workers，改为直连东财：
- F10 费率页（服务端渲染）解析 管理费/托管费/销售服务费 与 申赎状态文案；
- FundMNBasicInformation 提供 SGZT（申购状态）、MINSG/MAXSG 等字段。
"""
from __future__ import annotations

import json
import re
import urllib.request
from typing import Any, Callable

EASTMONEY_F10_FEE_URL = "https://fundf10.eastmoney.com/jjfl_{code}.html"
EASTMONEY_FUND_INFO_URL = "https://fundmobapi.eastmoney.com/FundMNewApi/FundMNBasicInformation"

_UA_HEADERS = {
    "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)",
    "accept": "application/json",
    "referer": "https://fundmobapi.eastmoney.com/",
}

FetchText = Callable[[str, float], str]
FetchJson = Callable[[str, float], dict[str, Any]]

_PURCHASE_STATUS_RE = re.compile(
    r"申购状态\s*(开放申购|暂停申购|暂停大额申购|限大额|限购|封闭期|暂停交易|即将开放)"
)
_REDEEM_STATUS_RE = re.compile(r"赎回状态\s*(开放赎回|暂停赎回|封闭期|暂停交易)")
_INVEST_STATUS_RE = re.compile(r"定投状态\s*(支持|不支持|开放|暂停|限大额)")
_FEE_RES = {
    "managementFeeRate": re.compile(r"管理费率\s*([0-9.]+)%"),
    "custodyFeeRate": re.compile(r"托管费率\s*([0-9.]+)%"),
    "salesServiceFeeRate": re.compile(r"销售服务费率\s*([0-9.]+)%"),
}


def _fetch_text(url: str, timeout: float) -> str:
    from .netutil import fetch_url

    raw = fetch_url(url, timeout, headers={"accept": "text/html"})
    return raw.decode("utf-8", "replace")


def _fetch_json(url: str, timeout: float) -> dict[str, Any]:
    from .netutil import fetch_url

    raw = fetch_url(url, timeout)
    payload = json.loads(raw.decode("utf-8", "replace"))
    if not isinstance(payload, dict):
        raise ValueError(f"eastmoney response is not an object: {url}")
    return payload


def _strip_tags(html: str) -> str:
    text = re.sub(r"<script[\s\S]*?</script>", " ", html, flags=re.I)
    text = re.sub(r"<style[\s\S]*?</style>", " ", text, flags=re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"&nbsp;?", " ", text)
    return re.sub(r"\s+", " ", text)


def _parse_html_tables(html: str) -> list[list[list[str]]]:
    """HTML 表格 → 行列表（每行是去标签后的非空单元格），与旧 worker 的 extractTables 同构。"""
    tables: list[list[list[str]]] = []
    for table_html in re.findall(r"<table\b[\s\S]*?</table>", html, flags=re.I):
        rows: list[list[str]] = []
        for tr in re.findall(r"<tr\b[\s\S]*?</tr>", table_html, flags=re.I):
            cells = [_strip_tags(cell) for cell in re.findall(r"<t[dh][^>]*>([\s\S]*?)</t[dh]>", tr, flags=re.I)]
            cells = [cell for cell in cells if cell]
            if cells:
                rows.append(cells)
        if rows:
            tables.append(rows)
    return tables


def _fee_tier_rows(tables: list[list[list[str]]], keyword: str) -> list[list[str]]:
    """从表格里提取费率阶梯行（如 赎回费率：[\"小于7天\", \"1.50%\"]）。

    只保留含百分数的行，表头（适用期限/赎回费率 等）自然被过滤。
    """
    for rows in tables:
        if not any(keyword in " ".join(row) for row in rows):
            continue
        tiers = [
            row for row in rows
            if any(re.search(r"\d+(?:\.\d+)?\s*[%％]", cell) for cell in row)
        ]
        if tiers:
            return tiers
    return []


def _normalize_code(code: Any) -> str:
    text = str(code or "").strip()
    return text if text.isdigit() and len(text) == 6 else ""


def _positive_float(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number == number and number > 0 else None


def _fee_float(value: Any) -> float | None:
    """费率解析：0 是合法值（如销售服务费率 0.00%），仅拒绝负数/非法。"""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number == number and number >= 0 else None


def fetch_f10_fees(
    code: str,
    timeout: float = 10.0,
    fetch_text: FetchText = _fetch_text,
) -> dict[str, Any] | None:
    """F10 费率页解析：运作费率 + 申赎状态文案（服务端渲染，无需 JS）。"""
    normalized = _normalize_code(code)
    if not normalized:
        return None
    try:
        html = fetch_text(EASTMONEY_F10_FEE_URL.format(code=normalized), timeout)
    except Exception:
        return None
    text = _strip_tags(html)
    rates: dict[str, float | None] = {}
    for key, pattern in _FEE_RES.items():
        match = pattern.search(text)
        rates[key] = _fee_float(match.group(1)) if match else None
    if all(value is None for value in rates.values()):
        return None
    purchase_match = _PURCHASE_STATUS_RE.search(text)
    redeem_match = _REDEEM_STATUS_RE.search(text)
    invest_match = _INVEST_STATUS_RE.search(text)
    purchase_status = purchase_match.group(1) if purchase_match else None
    redeem_status = redeem_match.group(1) if redeem_match else None
    invest_status = invest_match.group(1) if invest_match else None
    rules: list[list[str]] = []
    if purchase_status or redeem_status or invest_status:
        rules.append([
            "申购状态", purchase_status or "—",
            "赎回状态", redeem_status or "—",
            "定投状态", invest_status or "—",
        ])
    # 卖出费率阶梯：[持有期限, "1.50%"] 行，前端 resolveRedeemFeeRate 取 max。
    rules.extend(_fee_tier_rows(_parse_html_tables(html), "赎回费率"))
    operation_fees: list[list[str]] = []
    # 每项费率一行：前端 combineRuleRates 对每行只取一个百分数再求和，
    # 三项挤一行会只剩管理费。
    for label, key in (("管理费率", "managementFeeRate"), ("托管费率", "custodyFeeRate"), ("销售服务费率", "salesServiceFeeRate")):
        value = rates.get(key)
        if value is not None:
            operation_fees.append([label, f"{value:.2f}%（每年）"])
    management = rates.get("managementFeeRate")
    custody = rates.get("custodyFeeRate")
    sales = rates.get("salesServiceFeeRate")
    known = [value for value in (management, custody, sales) if value is not None]
    return {
        "code": normalized,
        "managementFeeRate": management,
        "custodyFeeRate": custody,
        "salesServiceFeeRate": sales,
        "operationFeeRate": management,
        "annualFeeRate": round(sum(known), 4) if known else None,
        "operationFees": operation_fees,
        "purchaseRules": [],
        "redeemRules": rules,
        "purchaseStatusText": purchase_status,
        "redeemStatusText": redeem_status,
        "source": "eastmoney-f10",
    }


def fetch_fund_info(
    code: str,
    timeout: float = 10.0,
    fetch_json: FetchJson = _fetch_json,
) -> dict[str, Any] | None:
    """移动端基金基本信息：SGZT（申购状态）、MINSG/MAXSG（单日申赎限额）等。"""
    normalized = _normalize_code(code)
    if not normalized:
        return None
    url = EASTMONEY_FUND_INFO_URL + f"?FCODE={normalized}&deviceid=Wap&plat=Wap&product=EFund&version=6.2.8"
    try:
        payload = fetch_json(url, timeout)
    except Exception:
        return None
    data = payload.get("Datas")
    if not isinstance(data, dict):
        data = payload
    sgzt = str(data.get("SGZT") or "").strip()
    if not sgzt:
        return None
    return {
        "code": normalized,
        "purchaseStatusText": sgzt,
        "purchaseStatusMark": str(data.get("SGZTMARK") or "").strip() or None,
        "minPurchase": _positive_float(data.get("MINSG")),
        "maxPurchasePerDay": _positive_float(data.get("MAXSG")),
        "fundName": str(data.get("SHORTNAME") or data.get("FUNDNAME") or "").strip() or None,
        # FEGM 基金份额（总份额）/ ENDNAV 资产净值（规模），行情中心的份额/规模数据源。
        "fundShares": _positive_float(data.get("FEGM")),
        "fundSize": _positive_float(data.get("ENDNAV")),
        "fundSharesAsOf": str(data.get("FEGMRQ") or "").strip()[:10] or None,
        "source": "eastmoney-fund-info",
    }


_BUY_STATUS_MAP = {
    "开放申购": "open",
    "限大额": "limit_large",
    "限购": "limit_large",
    "暂停大额申购": "limit_large",
    "暂停申购": "suspend",
    "封闭期": "suspend",
    "暂停交易": "suspend",
    "即将开放": "open",
}


def build_limit_payload(
    fund_info: dict[str, Any] | None,
    f10_fees: dict[str, Any] | None,
) -> dict[str, Any] | None:
    """东财直连数据 → fund_limit 参考快照 payload（与旧 worker 版同构）。"""
    info_status = str((fund_info or {}).get("purchaseStatusText") or "").strip()
    f10_status = str((f10_fees or {}).get("purchaseStatusText") or "").strip()
    status_text = info_status or f10_status
    if not status_text:
        return None
    buy_status = _BUY_STATUS_MAP.get(status_text)
    if buy_status is None:
        for keyword, mapped in _BUY_STATUS_MAP.items():
            if keyword in status_text:
                buy_status = mapped
                break
    max_purchase = None
    for source in (fund_info, f10_fees):
        value = _positive_float((source or {}).get("maxPurchasePerDay"))
        if value is not None:
            max_purchase = value
            break
    min_purchase = None
    for source in (fund_info, f10_fees):
        value = _positive_float((source or {}).get("minPurchase"))
        if value is not None:
            min_purchase = value
            break
    redeem_status_text = str((f10_fees or {}).get("redeemStatusText") or "").strip() or None
    redeem_status = _BUY_STATUS_MAP.get(redeem_status_text) if redeem_status_text else None
    if redeem_status is None and redeem_status_text:
        redeem_status = "open" if "开放" in redeem_status_text else "suspend"
    payload: dict[str, Any] = {
        "code": str((fund_info or f10_fees or {}).get("code") or ""),
        "buyStatus": buy_status or "open",
        "buyStatusText": status_text,
        "maxPurchasePerDay": max_purchase,
        "minPurchase": min_purchase,
        "channelLimits": {"all": max_purchase} if max_purchase is not None else None,
        "limitChannelText": str((fund_info or {}).get("purchaseStatusMark") or "") or None,
        "redeemStatus": redeem_status,
        "source": "eastmoney-direct",
    }
    if payload["channelLimits"] is None:
        payload.pop("channelLimits")
    return payload
