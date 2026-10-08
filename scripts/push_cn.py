#!/usr/bin/env python3
"""Push local cn HEAD to origin/cn via GitHub Git Data API (fast-forward only).

Usage: push_cn.py <base_commit> <message> <file>...
Reads <file> contents from the working tree, creates blobs + tree + commit.
Kept in the repo workspace (not /tmp) so it survives tmp wipes.
"""
import base64
import json
import sys
import urllib.request
import urllib.error

sys.path.insert(0, "/opt/hatch/skills/skill-creator/bin")
from dynamic_credentials import add_surrogate_to_request, read_json_response

ALLOWED = ["api.github.com"]
REPO = "lovexlc/ai-dca"


def api(method, path, payload=None):
    url = "https://api.github.com/" + path.lstrip("/")
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "Accept": "application/vnd.github+json",
        "User-Agent": "muse-skill-github",
        "Content-Type": "application/json",
    })
    add_surrogate_to_request(req, "custom.github", allowed_hosts=ALLOWED)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return read_json_response(resp)
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")[:2000]
        raise SystemExit(f"HTTP {exc.code} {method} {path}: {body}")


def main():
    base_commit, message, files = sys.argv[1], sys.argv[2], sys.argv[3:]
    ref = api("GET", f"repos/{REPO}/git/refs/heads/cn")
    remote_sha = ref["object"]["sha"]
    if remote_sha != base_commit:
        raise SystemExit(
            f"REFUSING: remote cn is {remote_sha}, expected {base_commit}. Fetch first.")
    base_tree = api("GET", f"repos/{REPO}/git/commits/{base_commit}")["tree"]["sha"]
    tree_entries = []
    for path in files:
        with open(path, "rb") as fh:
            content = base64.b64encode(fh.read()).decode()
        blob = api("POST", f"repos/{REPO}/git/blobs",
                   {"content": content, "encoding": "base64"})
        tree_entries.append({"path": path, "mode": "100644",
                             "type": "blob", "sha": blob["sha"]})
        print(f"blob {path}: {blob['sha'][:8]}")
    tree = api("POST", f"repos/{REPO}/git/trees",
               {"base_tree": base_tree, "tree": tree_entries})
    commit = api("POST", f"repos/{REPO}/git/commits",
                 {"message": message, "tree": tree["sha"],
                  "parents": [base_commit]})
    new_sha = commit["sha"]
    api("PATCH", f"repos/{REPO}/git/refs/heads/cn", {"sha": new_sha})
    print(f"pushed cn: {base_commit[:8]} -> {new_sha[:8]}")


if __name__ == "__main__":
    raise SystemExit(main())
