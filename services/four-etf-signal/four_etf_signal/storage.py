"""Durable, independent state and append-only audit log."""
import json
import os
from pathlib import Path


def read_json(path):
    with Path(path).open() as f:
        return json.load(f)


def atomic_json(path, value):
    path = Path(path)
    tmp = path.with_name(path.name + f".{os.getpid()}.tmp")
    path.parent.mkdir(parents=True, exist_ok=True)
    with tmp.open("w") as f:
        json.dump(value, f, ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False)
        f.write("\n")
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)
    fd = os.open(path.parent, os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def append_json(path, value):
    with Path(path).open("a") as f:
        f.write(json.dumps(value, sort_keys=True, ensure_ascii=False, allow_nan=False) + "\n")
        f.flush()
        os.fsync(f.fileno())
