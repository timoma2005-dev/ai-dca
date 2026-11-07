"""Cron entry: inherit existing sync-daemon auth in memory, never copy keys.

Only the exact, root-owned existing syncDaemon.js process is trusted. No
session token/hash, channel token, email address, or provider key is read here.
"""
from __future__ import annotations

import os
from pathlib import Path
import sys

sys.dont_write_bytecode = True


def inherit_internal_auth():
    if os.environ.get('INTERNAL_SYNC_TOKEN'):
        return
    tokens = set()
    expected = b'/opt/ai-dca-cn-data/src/syncDaemon.js'
    for process in Path('/proc').glob('[0-9]*'):
        try:
            if process.stat().st_uid != 0:
                continue
            argv = (process / 'cmdline').read_bytes().split(b'\0')
            if expected not in argv or not argv[0].endswith(b'/node'):
                continue
            environment = dict(item.split(b'=', 1) for item in (process / 'environ').read_bytes().split(b'\0') if b'=' in item)
            token = environment.get(b'INTERNAL_SYNC_TOKEN')
            if token:
                tokens.add(token)
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            continue
    if len(tokens) == 1:
        try:
            os.environ['INTERNAL_SYNC_TOKEN'] = tokens.pop().decode('ascii')
        except UnicodeDecodeError:
            pass
    # A missing/conflicting existing credential fails in notify(), without
    # reading any raw credential file or falling back to a user session hash.


if __name__ == '__main__':
    if any(flag in sys.argv for flag in ['--live', '--check-notify', '--verify-delivery']):
        inherit_internal_auth()
    from relprice_signal.__main__ import main
    main()
