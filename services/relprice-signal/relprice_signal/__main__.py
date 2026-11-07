from __future__ import annotations

import argparse
import json

from .notify import notify
from .runner import Store, run


def main():
    parser = argparse.ArgumentParser(description="B_REL reference signals only; no automatic trading")
    parser.add_argument("--config", required=True)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--live", action="store_true")
    mode.add_argument("--dry-run", action="store_true")
    mode.add_argument("--check-notify", action="store_true", help="authenticated binding check; never sends")
    mode.add_argument("--verify-delivery", metavar="EVENT_ID", help="read the D1 email attempt; never sends")
    mode.add_argument("--set-holding")
    parser.add_argument("--as-of")
    parser.add_argument("--reason")
    args = parser.parse_args()
    config = json.load(open(args.config))
    config["_config_path"] = args.config
    if args.verify_delivery:
        result = notify(config, {"owner_user_id": config["owner_user_id"], "dry_run": True, "verify_event_id": args.verify_delivery})
    elif args.check_notify:
        result = notify(config, {"owner_user_id": config["owner_user_id"], "dry_run": True})
    elif args.set_holding:
        if not args.as_of or not args.reason:
            parser.error("--set-holding needs --as-of YYYY-MM-DD and --reason")
        store = Store(config)
        with store.lock():
            result = store.set_holding(args.set_holding, args.as_of, args.reason)
    else:
        result = run(config, dry_run=not args.live)
    print(json.dumps(result, ensure_ascii=False, sort_keys=True, allow_nan=False))


if __name__ == "__main__":
    main()
