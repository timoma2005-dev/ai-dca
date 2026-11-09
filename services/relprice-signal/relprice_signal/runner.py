"""One daily frozen signal, paper reference state, and auditable delivery."""
from __future__ import annotations

from datetime import datetime, timedelta
import fcntl
import json
from pathlib import Path
import time

from .data import LiveMarket, TZ, digest, history_from_db, prior_days, signal_prices, trading_day, validate_latest
from .notify import notify
from .rules import CODES, DataUnavailable, decide, first_common_bar


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    with temp.open("w") as handle:
        json.dump(value, handle, ensure_ascii=False, sort_keys=True, allow_nan=False)
        handle.write("\n")
        handle.flush()
        __import__("os").fsync(handle.fileno())
    temp.replace(path)


class Store:
    def __init__(self, config):
        self.directory = Path(config["data_dir"])
        self.directory.mkdir(parents=True, exist_ok=True)
        self.config = config

    def state(self):
        path = self.directory / "state.json"
        if path.exists():
            state = json.loads(path.read_text())
        else:
            state = {"held_code": self.config["initial_holding"], "as_of": self.config["initial_as_of"],
                     "revision": 0, "kind": "strategy_reference", "actual_holding_confirmed": False}
        if state["held_code"] not in CODES:
            raise DataUnavailable("invalid_state_holding")
        return state

    def log(self, record):
        record = {"strategy": "B_REL", "logged_at": datetime.now(TZ).isoformat(), **record}
        path = self.directory / "signals.jsonl"
        with path.open("a") as handle:
            handle.write(json.dumps(record, ensure_ascii=False, sort_keys=True, allow_nan=False) + "\n")
            handle.flush()
            __import__("os").fsync(handle.fileno())
        return record

    def set_holding(self, code, as_of, reason):
        if code not in CODES or not reason.strip():
            raise ValueError("valid code and non-empty reason required")
        datetime.strptime(as_of, "%Y-%m-%d")
        previous = self.state()
        state = {"held_code": code, "as_of": as_of, "revision": previous["revision"] + 1,
                 "kind": "strategy_reference", "actual_holding_confirmed": True,
                 "override_reason": reason, "updated_at": datetime.now(TZ).isoformat()}
        # Audit first: an interrupted write cannot silently change the holding.
        self.log({"date": as_of, "decision": "manual_override", "previous_holding": previous["held_code"], "holding": code, "reason": reason})
        atomic_json(self.directory / "state.json", state)
        return state

    def lock(self):
        handle = (self.directory / "run.lock").open("a")
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return handle


def completed_time(now):
    # Quote providers may still be publishing the just-ended bar. Wait 8s.
    return now if now.second >= 8 else now - timedelta(minutes=1)


def run(config, *, dry_run=True, market=None, clock=None, sleeper=time.sleep, sender=notify):
    store = Store(config)
    with store.lock():
        return _run(config, store, dry_run, market or LiveMarket(config["latest_url"], snapshot_path=config.get("tick_snapshot_path"), max_age=config["max_snapshot_age_sec"], clock=clock),
                    clock or (lambda: datetime.now(TZ)), sleeper, sender)


def _run(config, store, dry_run, market, clock, sleeper, sender):
    now = clock()
    day = now.strftime("%Y%m%d")
    state = store.state()
    record = {"date": now.date().isoformat(), "mode": "dry-run" if dry_run else "live",
              "holding": state["held_code"], "target": None, "gap_bp": None,
              "decision": "skip", "data_freshness": {}, "state_revision": state["revision"]}
    try:
        if config["notification_mode"] not in ("disabled", "after_dry_run", "enabled"):
            raise DataUnavailable("invalid_notification_mode")
        if not trading_day(now.date()):
            raise DataUnavailable("non_trading_day")
        if now.strftime("%H%M") != "1440":
            raise DataUnavailable("outside_signal_start_window")
        if state["as_of"] >= now.date().isoformat():
            raise DataUnavailable("state_not_before_signal_date")
        receipt_path = store.directory / ("decision-" + day + ".json")
        if not dry_run and receipt_path.exists():
            raise DataUnavailable("daily_decision_already_committed")
        if now.second < 8:
            sleeper(8 - now.second)
        snapshot = market.latest()
        record["data_freshness"] = validate_latest(snapshot, clock(), config["max_snapshot_age_sec"])
        days = prior_days(now.date())
        history, _ = history_from_db(config["history_db"], days)
        bars = market.bars(CODES, day, completed_time(clock()))
        prices, valid = signal_prices(bars, day)
        # A full cross section is retained; uncertain intraday eligibility
        # closes this run instead of producing a smaller, different universe.
        if not all(valid.values()):
            raise DataUnavailable("signal_minute_no_volume")
        decision = decide([history[d] for d in days], prices, valid, state["held_code"])
        record.update(decision)
        record.update({"signal_ts": now.date().isoformat() + "T14:40:00+08:00",
                       "history_dates": days, "signal_prices": prices,
                       "input_sha256": digest({"history": history, "prices": prices, "valid": valid, "state": state}),
                       "event_id": "relprice:B_REL:" + now.date().isoformat()})
        # Always calculate and log a dry-run of this exact frozen input before
        # enabling any delivery. A rehearsal cannot update reference holdings.
        store.log({**record, "mode": "dry-run", "stage": "calculated", "push": "disabled"})
        if decision["decision"] == "rotate":
            execution = None
            while clock().strftime("%H%M%S") <= "150045":
                current = clock()
                if current.strftime("%H%M%S") >= "144108":
                    pair = market.bars([decision["holding"], decision["target"]], day, completed_time(current))
                    execution = first_common_bar(pair, decision["holding"], decision["target"])
                    if execution:
                        break
                sleeper(10)
            if execution is None:
                record.update({"decision": "cancel", "reason": "no_common_positive_execution_bar", "push": "disabled"})
                return store.log(record)
            record["execution_reference"] = execution
            # Price references above are diagnostic paper fills, never orders.
            record["data_freshness"] = validate_latest(market.latest(), clock(), config["max_snapshot_age_sec"])
        validated = store.log({**record, "mode": "dry-run", "stage": "validated", "push": "disabled"})
        if dry_run:
            return validated
        # Bootstrap once: actual delivery remains disabled until a complete,
        # fresh, trading-session dry-run has passed and been logged above.
        if config["notification_mode"] == "after_dry_run":
            config_path = config.get("_config_path")
            if not config_path:
                raise DataUnavailable("missing_config_path_for_arming")
            persisted = {k: v for k, v in config.items() if not k.startswith("_")}
            persisted["notification_mode"] = "enabled"
            atomic_json(store.directory / "live-dry-run-passed.json", {
                "date": record["date"], "input_sha256": record["input_sha256"],
                "validated_at": clock().isoformat(), "event_id": record["event_id"]})
            atomic_json(config_path, persisted)
            Path(config_path).chmod(0o600)
            config["notification_mode"] = "enabled"
            record["notification_armed_after_dry_run"] = True
        # Commit the paper reference transition before uncertain network I/O.
        # An interrupted/failed send never causes an automatic duplicate email.
        record["push"] = "pending" if decision["decision"] == "rotate" else "not_required"
        atomic_json(receipt_path, record)
        atomic_json(store.directory / "state.json", {"held_code": decision["next_holding"],
                    "as_of": now.date().isoformat(), "revision": state["revision"] + 1,
                    "kind": "strategy_reference", "actual_holding_confirmed": False,
                    "last_event_id": record["event_id"]})
        if decision["decision"] == "rotate":
            if config["notification_mode"] != "enabled":
                record["push"] = "disabled_by_config"
            else:
                result = sender(config, {"owner_user_id": config["owner_user_id"], "date": record["date"],
                    "holding": decision["holding"], "target": decision["target"], "gap_bp": decision["gap_bp"],
                    "decision": "rotate", "signal_ts": record["signal_ts"], "event_id": record["event_id"],
                    "input_sha256": record["input_sha256"], "execution_reference": record["execution_reference"],
                    "generated_at": clock().isoformat()})
                # HTTP/queue acknowledgment is not delivery ground truth.
                record["push"] = result.get("status", "accepted_pending_d1_verification")
                record["delivery_attempt"] = result.get("delivery_attempt")
                if record["delivery_attempt"] and record["delivery_attempt"].get("status") == "delivered":
                    proof = store.directory / "first-delivery.json"
                    if not proof.exists():
                        atomic_json(proof, record["delivery_attempt"])
        atomic_json(receipt_path, record)
        return store.log({**record, "stage": "committed"})
    except Exception as error:
        # Fixed error identifiers only. Never log arbitrary HTTP exception text.
        reason = str(error) if isinstance(error, DataUnavailable) else "source_error:" + type(error).__name__
        if record.get("push") == "pending":
            record.update({"push": "failed_or_unknown", "delivery_error": reason})
            atomic_json(store.directory / ("decision-" + day + ".json"), record)
        else:
            record.update({"decision": "skip", "reason": reason, "push": "disabled"})
        return store.log(record)
