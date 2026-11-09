"""One bounded cron run, protected by flock; no catch-up or POST retries."""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from datetime import date, datetime, time
import fcntl
import json
import os
from pathlib import Path
import time as clock

from .calendar import quarter_start, trading_day
from .data import TZ, NAV_SOURCE, LiveMarket, fetch_nav, preopen_nav, validate_nav
from .history import archive, initial_normal, load_normal, recalculate, save_bars, save_nav
from .notify import notify
from .rules import CODES, DataUnavailable, advance, is_minute
from .storage import append_json, atomic_json, read_json

OWNER = "usr_ad2be81697b5eec7ca3b2204efb7270c"


def initialize(config, directory):
    path = directory / "state.json"
    if not path.exists():
        if config.get("initial_holding") not in CODES:
            raise DataUnavailable("invalid_initial_holding")
        atomic_json(path, {"strategy": "fourETF", "holding": config["initial_holding"],
                           "as_of": config["initial_as_of"], "actual_holding_confirmed": True,
                           "pending": None, "revision": 0, "last_minute": ""})
    initial_normal(directory)
    return read_json(path)


def prepare_nav(directory, now, fetcher=fetch_nav, clock_now=lambda: datetime.now(TZ)):
    path = directory / ("nav-" + now.date().isoformat() + ".json")
    if path.exists():
        record = read_json(path)
        validate_nav(record, now.date())
        return record
    with ThreadPoolExecutor(max_workers=3) as pool:
        histories = dict(zip(CODES, pool.map(fetcher, CODES)))
    with archive(directory / "history.sqlite3") as db:
        save_nav(db, histories, NAV_SOURCE)
    record = preopen_nav(now.date(), clock_now(), histories)
    atomic_json(path, record)
    return record


def payload_for(confirmed, now):
    label = confirmed["signal_minute"]
    signal = datetime.strptime(label, "%Y%m%d%H%M").replace(tzinfo=TZ)
    return {"owner_user_id": OWNER, "date": signal.date().isoformat(), "decision": "rotate",
            "event_id": confirmed["event_id"], "signal_ts": signal.isoformat(),
            "holding": confirmed["holding"], "target": confirmed["target"], "gap_pp": confirmed["gap_pp"],
            "deviations_pp": confirmed["deviations_pp"], "normal_pp": confirmed["normal_pp"],
            "eligible": confirmed["eligible"],
            "normal_effective": confirmed["normal_effective"], "nav_date": confirmed["nav_date"],
            "nav_ready_at": confirmed["nav_ready_at"], "input_sha256": confirmed["input_sha256"],
            "generated_at": now.isoformat(), "execution_reference": {
                "time": confirmed["execution_minute"][-4:], "sell_close": confirmed["sell_close"],
                "buy_close": confirmed["buy_close"], "sell_volume": confirmed["sell_volume"],
                "buy_volume": confirmed["buy_volume"]}}


def deliver_once(directory, config, confirmed, now, sender=notify):
    events = directory / "events"
    events.mkdir(exist_ok=True)
    path = events / (confirmed["event_id"].replace(":", "_") + ".json")
    if path.exists():
        return {"status": "already_attempted", "event_id": confirmed["event_id"]}
    payload = payload_for(confirmed, now)
    receipt = {"event_id": confirmed["event_id"], "attempted_at": now.isoformat(),
               "status": "attempt_committed", "payload": payload}
    atomic_json(path, receipt)
    try:
        result = sender(config, payload)
        attempt = result.get("delivery_attempt") or {}
        if (not result.get("ok") or attempt.get("status") != "delivered"
                or attempt.get("event_id") != confirmed["event_id"]
                or attempt.get("owner_user_id") != OWNER or attempt.get("channel") != "email"):
            raise DataUnavailable("delivery_not_verified")
        receipt.update(status="delivered", delivery_attempt=attempt)
        proof = directory / "first-delivery.json"
        if not proof.exists():
            atomic_json(proof, receipt)
    except (DataUnavailable, OSError, ValueError) as e:
        receipt.update(status="failed_or_unknown_no_retry", reason=str(e) if isinstance(e, DataUnavailable) else type(e).__name__)
    atomic_json(path, receipt)
    return {k: v for k, v in receipt.items() if k != "payload"}


def run(config, args, directory, state, now, market=None, sender=notify, clock_now=lambda: datetime.now(TZ)):
    log = {"strategy": "fourETF", "logged_at": now.isoformat(), "date": now.date().isoformat(),
           "minute": now.strftime("%H%M"), "mode": "live" if args.live else "dry-run",
           "holding": state["holding"], "push": "none", "state_revision": state["revision"]}
    if not trading_day(now.date()):
        return {**log, "decision": "skip", "reason": "non_trading_day"}
    if time(6) <= now.time().replace(tzinfo=None) < time(9, 30):
        if now.minute % 5 != 0 and now.strftime("%H%M") != "0929":
            return {**log, "decision": "skip", "reason": "preopen_retry_interval"}
        if not args.live:
            return {**log, "decision": "skip", "reason": "dry_run_preopen_no_mutation"}
        if now.date() >= date(2027, 1, 1):
            recalculate(directory, config["history_db"], quarter_start(now.date()))
        record = prepare_nav(directory, now)
        return {**log, "decision": "nav_ready", "nav_date": record["nav_date"], "nav_sha256": record["sha256"]}
    if not is_minute(now.strftime("%H%M")):
        return {**log, "decision": "skip", "reason": "outside_session"}
    if not 8 <= now.second <= 45:
        return {**log, "decision": "skip", "reason": "outside_completion_window"}
    label = now.strftime("%Y%m%d%H%M")
    if state.get("last_minute", "") >= label:
        return {**log, "decision": "skip", "reason": "minute_already_processed"}
    market = market or LiveMarket(config["latest_url"], snapshot_path=config.get("tick_snapshot_path"))
    bars, histories, freshness = market.collect(now)
    finished = clock_now()
    elapsed = (finished - now).total_seconds()
    if (finished.strftime("%Y%m%d%H%M") != label or finished.second > 45
            or freshness["snapshot_age_sec"] + elapsed > config.get("max_snapshot_age_sec", 45)):
        raise DataUnavailable("data_expired_during_fetch")
    for c in bars:
        age = freshness["symbols"][c]["age_sec"]
        bars[c]["stale"] |= age is None or age + elapsed > config.get("max_snapshot_age_sec", 45)
    if args.live:
        with archive(directory / "history.sqlite3") as db:
            save_bars(db, histories)
    # Archiving completed bars is independent of the all-day NAV gate, so a
    # missed NAV publication does not create a hole in the next quarter's fit.
    nav_path = directory / ("nav-" + now.date().isoformat() + ".json")
    if not nav_path.exists():
        raise DataUnavailable("nav_not_ready_before_open_day_closed")
    nav_record = read_json(nav_path)
    nav = validate_nav(nav_record, now.date())
    normal_record = load_normal(directory, now.date())
    new_state, result = advance(deepcopy(state), label, bars, nav, normal_record["normal_pp"])
    if new_state.get("pending") and new_state["pending"]["signal_minute"] == label:
        new_state["pending"].update(nav_date=nav_record["nav_date"], nav_ready_at=nav_record["ready_at"],
                                    normal_effective=normal_record["effective"], normal_pp=normal_record["normal_pp"])
    frozen = {"minute": label, "bars": bars, "nav_record": nav_record, "normal_record": normal_record,
              "freshness": freshness, "state_before": state, "result": result}
    if args.live:
        atomic_json(directory / "inputs" / label[:8] / (label[-4:] + ".json"), frozen)
        atomic_json(directory / "state.json", new_state)
    output = {**log, **result, "data_freshness": freshness, "nav_date": nav_record["nav_date"],
              "nav_sha256": nav_record["sha256"], "normal_effective": normal_record["effective"],
              "normal_pp": normal_record["normal_pp"], "normal_sha256": normal_record["sha256"],
              "holding_after": new_state["holding"], "state_revision_after": new_state["revision"]}
    if result.get("confirmed"):
        if args.live and config.get("notification_mode") == "enabled":
            output["push"] = deliver_once(directory, config, result["confirmed"], finished, sender=sender)
        else:
            output["push"] = "dry_run" if not args.live else "disabled"
    return output


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--live", action="store_true")
    mode.add_argument("--dry-run", action="store_true")
    mode.add_argument("--init-state", action="store_true")
    mode.add_argument("--check-notify", action="store_true")
    mode.add_argument("--verify-delivery")
    mode.add_argument("--set-holding", choices=CODES)
    mode.add_argument("--recalculate", action="store_true")
    parser.add_argument("--as-of")
    parser.add_argument("--reason")
    args = parser.parse_args(argv)
    config = read_json(args.config)
    if config.get("notification_mode") not in ("enabled", "disabled") or config.get("owner_user_id") != OWNER:
        parser.error("invalid notification mode or owner")
    directory = Path(config["data_dir"])
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock = (directory / "run.lock").open("a")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print(json.dumps({"decision": "skip", "reason": "run_locked"}))
        return 0
    now = datetime.now(TZ)
    state = initialize(config, directory)
    try:
        if args.check_notify or args.verify_delivery:
            body = {"owner_user_id": OWNER, "dry_run": True}
            if args.verify_delivery:
                body["verify_event_id"] = args.verify_delivery
            result = notify(config, body)
        elif args.init_state:
            result = {"decision": "initialized", "holding": state["holding"], "revision": state["revision"]}
        elif args.set_holding:
            if not args.as_of or not args.reason:
                parser.error("--as-of and --reason are required")
            as_of = date.fromisoformat(args.as_of)
            if as_of > now.date():
                parser.error("as-of is in the future")
            new_state = {**state, "holding": args.set_holding, "as_of": as_of.isoformat(), "pending": None,
                         "actual_holding_confirmed": True, "revision": state["revision"] + 1}
            atomic_json(directory / "state.json", new_state)
            result = {"decision": "holding_override", "before": state, "after": new_state, "reason": args.reason}
        elif args.recalculate:
            effective = quarter_start(now.date())
            if effective < date(2027, 1, 1):
                result = {"decision": "skip", "reason": "initial_normal_valid_until_2027_01_01"}
            else:
                result = {"decision": "normal_recalculated", "normal": recalculate(directory, config["history_db"], effective)}
        else:
            if (args.live and trading_day(now.date()) and is_minute(now.strftime("%H%M")) and now.second < 8):
                clock.sleep(8 - now.second - now.microsecond / 1_000_000)
                now = datetime.now(TZ)
            result = run(config, args, directory, state, now)
    except (DataUnavailable, OSError, ValueError, KeyError) as e:
        result = {"decision": "skip", "reason": str(e) if isinstance(e, DataUnavailable) else type(e).__name__,
                  "holding": state["holding"], "push": "none"}
    result = {"strategy": "fourETF", "logged_at": datetime.now(TZ).isoformat(), "date": now.date().isoformat(),
              "mode": "live" if args.live else "dry-run", **result}
    append_json(directory / "signals.jsonl", result)
    print(json.dumps(result, ensure_ascii=False, sort_keys=True, allow_nan=False))
    return 0
