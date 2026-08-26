#!/usr/bin/env python3
"""Drive fsmcp over stdio and assert against the disk.

Shell quoting around nested JSON produced false PASSes in an earlier version of
this harness -- a call that never ran looks exactly like a call that changed
nothing. Everything here builds requests with json.dumps and checks results
against shasum/xattr/ls, never against fsMCP's own reported values.
"""
import hashlib
import json
import os
import subprocess
import sys

BIN, ROOT = sys.argv[1], sys.argv[2]
OUTSIDE = os.path.join(os.path.dirname(ROOT), "outside")

FAILS: list[str] = []


def call(tool, args, extra_env=None):
    """One tools/call against a fresh server process. Returns the payload dict."""
    lines = [
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/call",
         "params": {"name": tool, "arguments": args}},
    ]
    env = dict(os.environ, **(extra_env or {}))
    p = subprocess.run([BIN, "--root", ROOT], input="\n".join(json.dumps(l) for l in lines) + "\n",
                       capture_output=True, text=True, env=env)
    out = [l for l in p.stdout.splitlines() if l.strip()]
    if not out:
        return {"ok": False, "error": {"code": "NO_REPLY", "message": p.stderr[:200]}}
    last = json.loads(out[-1])
    if "result" not in last:
        return {"ok": False, "error": {"code": "RPC_ERROR", "message": json.dumps(last)[:200]}}
    return json.loads(last["result"]["content"][0]["text"])


def show(label, payload):
    if payload.get("ok"):
        body = {k: v for k, v in payload.items() if k != "ok"}
        print("  %-32s OK      %s" % (label, json.dumps(body)[:88]))
    else:
        e = payload["error"]
        print("  %-32s REFUSE  %s | %s" % (label, e["code"], e["message"][:64]))
    return payload


def check(label, cond, detail=""):
    print("  %-32s %s %s" % (label, "PASS" if cond else "FAIL", detail))
    if not cond:
        FAILS.append(label)


def disk_sha(rel):
    path = os.path.join(ROOT, rel)
    if not os.path.exists(path):
        return None
    return hashlib.sha256(open(path, "rb").read()).hexdigest()


def stat_sha(rel):
    return call("fs_stat", {"path": rel}).get("sha256", "")


def meta(rel):
    path = os.path.join(ROOT, rel)
    x = subprocess.run(["xattr", "-l", path], capture_output=True, text=True).stdout
    a = subprocess.run(["ls", "-le", path], capture_output=True, text=True).stdout
    return x, "\n".join(a.splitlines()[1:])


def temp_leftovers():
    found = []
    for d, _, files in os.walk(ROOT):
        found += [f for f in files if f.startswith(".fsmcp-tmp-")]
    return found


def section(t):
    print("\n" + "=" * 4, t, "=" * 4)
