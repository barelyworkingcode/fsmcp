#!/usr/bin/env python3
"""The scope battery: can a client exfiltrate or destroy outside its grant?

Two questions only, and both are judged by outcome, not by error code:

  1. EXFILTRATION — did any byte of an out-of-scope file reach the client?
     Every reply is searched for the canary strings, whatever the reply's
     shape. A refusal that happens to quote the secret still fails.

  2. DESTRUCTION — did anything outside the grant change or disappear?
     A full inventory (path, size, sha256) of the surrounding tree is taken
     before and after, and compared. A tool that reports failure while having
     already unlinked something still fails.

Run against the full stack (relayremote -> relay -> fsmcp) or against fsmcp
directly. usage: scope.py <relayremote|direct> [binary] [root]
"""
import hashlib
import json
import os
import subprocess
import sys

BWC = "/Users/admin/source/barelyworkingcode"
GRANT = f"{BWC}/testfolder"
OUTSIDE = f"{BWC}/scope-canary"

CANARIES = ["EXFIL-CANARY-7f3a91c2", "EXFIL-CANARY-DEEP-4b8e", "EXFIL-CANARY-BIN"]
# Never sent by the client, so seeing it back means the tree was enumerated.
NAME_CANARY = "EXFILNAME-9c2af41b.txt"
FAILS: list[str] = []


def setup():
    subprocess.run(["chmod", "-RN", OUTSIDE], capture_output=True)
    subprocess.run(["rm", "-rf", OUTSIDE], check=False)
    os.makedirs(f"{OUTSIDE}/subdir/nested", exist_ok=True)
    open(f"{OUTSIDE}/secret.txt", "w").write(CANARIES[0] + "\n")
    open(f"{OUTSIDE}/subdir/deep.txt", "w").write(CANARIES[1] + "\n")
    open(f"{OUTSIDE}/subdir/nested/leaf.txt", "w").write("leaf\n")
    open(f"{OUTSIDE}/binary.dat", "wb").write(CANARIES[2].encode() + bytes(range(256)))
    open(f"{OUTSIDE}/{NAME_CANARY}", "w").write("its name is the secret\n")
    # A credential-shaped file: the thing a client must never be able to
    # replace, truncate or append to from outside its grant.
    open(f"{OUTSIDE}/passwd", "w").write("root:x:0:0:root:/root:/bin/sh\n")
    os.chmod(f"{OUTSIDE}/passwd", 0o644)


# Files outside the grant that must be byte-identical afterwards, whatever
# any call reported. A tool that answers "refused" having already truncated
# one of these still fails.
SENTINELS = ["/etc/passwd", "/etc/hosts",
             f"{OUTSIDE}/passwd", f"{OUTSIDE}/secret.txt", f"{OUTSIDE}/binary.dat"]


def file_hash(p):
    try:
        return hashlib.sha256(open(p, "rb").read()).hexdigest()
    except OSError as e:
        return f"unreadable:{e.errno}"


def sentinel_state():
    st = {}
    for p in SENTINELS:
        st[p] = (file_hash(p), os.stat(p).st_mode if os.path.exists(p) else None,
                 os.path.getsize(p) if os.path.exists(p) else None)
    return st


def listing(d):
    """Names only — cheap enough to run over a big tree, and enough to catch
    a file the client managed to create where it should not have."""
    try:
        return set(os.listdir(d))
    except OSError:
        return set()


def inventory(root):
    out = {}
    for d, dirs, files in os.walk(root):
        for name in dirs:
            out[os.path.join(d, name)] = "dir"
        for name in files:
            p = os.path.join(d, name)
            try:
                out[p] = hashlib.sha256(open(p, "rb").read()).hexdigest()
            except OSError as e:
                out[p] = f"unreadable:{e.errno}"
    return out


class Stack:
    """Calls through relayremote -> relay -> fsmcp, the real deployment."""

    def __init__(self):
        self.env = dict(os.environ,
                        RELAY_REMOTE_ADDR="127.0.0.1:9910",
                        RELAY_REMOTE_BUNDLE=os.path.expanduser(
                            "~/Library/Application Support/relay/enrolments/hermes-v3"))
        self.bin = "/tmp/rr-v3"

    def call(self, tool, args):
        p = subprocess.run([self.bin, "call", "--tool", tool, "--args", json.dumps(args)],
                           capture_output=True, text=True, env=self.env, timeout=90)
        return p.stdout + p.stderr


class Direct:
    """Calls fsmcp over stdio, no relay. Isolates fsMCP's own boundary."""

    def __init__(self, binary, root):
        self.bin, self.root = binary, root

    def call(self, tool, args):
        lines = [
            {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/call",
             "params": {"name": tool, "arguments": args}},
        ]
        p = subprocess.run([self.bin, "--root", self.root],
                           input="\n".join(json.dumps(l) for l in lines) + "\n",
                           capture_output=True, text=True, timeout=90)
        return p.stdout + p.stderr


# Every way out of the grant worth trying. The grant contains these symlinks
# already: etc_link -> /etc, parent_link -> .., passwd_link -> /etc/passwd,
# dangling_link -> a nonexistent target.
def payload_of(reply):
    """The tool payload, whichever client produced it: relayremote prints it
    directly, Direct emits whole JSON-RPC lines."""
    line = reply.strip().splitlines()[-1] if reply.strip() else ""
    try:
        d = json.loads(line)
    except Exception:
        return {}
    if "result" in d and isinstance(d["result"], dict) and "content" in d["result"]:
        try:
            return json.loads(d["result"]["content"][0]["text"])
        except Exception:
            return {}
    return d if isinstance(d, dict) else {}


def two_step_overwrite(client):
    """stat -> write-with-that-hash, the way a client would really replace a
    file it does not own. if_sha256:null can never overwrite anything: it means
    "must not exist"."""
    targets = ["passwd", f"{OUTSIDE}/passwd", "../scope-canary/passwd",
               "parent_link/scope-canary/passwd", "/etc/passwd", "passwd_link"]
    out = []
    for t in targets:
        reply = client.call("fs_stat", {"path": t})
        h = payload_of(reply).get("sha256")
        args = {"path": t, "content": "root:x:0:0:PWNED:/root:/bin/sh\n",
                "if_sha256": h if h else None}
        out.append(("fs_write", args))
        out.append(("fs_replace", {"path": t, "if_sha256": h if h else None,
                                   "edits": [{"find": "root", "replace": "PWNED"}]}))
    return out


def attacks():
    up = "../scope-canary"
    esc = [
        "/Users/admin/source/barelyworkingcode/scope-canary/secret.txt",
        f"{up}/secret.txt",
        f"../../barelyworkingcode/scope-canary/secret.txt",
        f"notes/../{up}/secret.txt",
        f"./{up}/secret.txt",
        f"{up}//secret.txt",
        f"{up}/./secret.txt",
        "parent_link/scope-canary/secret.txt",
        "etc_link/passwd",
        "passwd_link",
        f"deep/a/../../{up}/secret.txt",
        "..%2Fscope-canary%2Fsecret.txt",
        "..\\/scope-canary/secret.txt",
        f"{'../' * 12}etc/passwd",
        f"{up}/binary.dat",
        f"{up}/subdir/deep.txt",
        f"{up}/passwd",
        "parent_link/scope-canary/passwd",
    ]
    for p in esc:
        yield "fs_read", {"path": p}
        yield "fs_stat", {"path": p}
    for p in esc[:8]:
        yield "fs_list", {"path": os.path.dirname(p) or "."}
        yield "fs_delete", {"path": p, "recursive": True}
        yield "fs_write", {"path": p, "content": "CLOBBERED", "if_sha256": None}
        yield "fs_mkdir", {"path": p + "/made"}
        yield "fs_move", {"source": "notes/Meeting.md", "destination": p}
        yield "fs_move", {"source": p, "destination": "stolen.txt"}
        yield "fs_replace", {"path": p, "if_sha256": None,
                             "edits": [{"find": "EXFIL", "replace": "X"}]}

    # Writing through a symlink that leaves the grant, including a dangling one
    # (a write through a dangling link creates the target where it points).
    for link in ("etc_link/pwned", "parent_link/pwned.txt", "dangling_link"):
        yield "fs_write", {"path": link, "content": "PWNED", "if_sha256": None}
        yield "fs_delete", {"path": link, "recursive": True}

    # Search reaching outward, including for the canary text itself.
    for pat in ("EXFIL-CANARY", "EXFIL"):
        yield "fs_grep", {"pattern": pat}
        yield "fs_grep", {"pattern": pat, "path": ".."}
        yield "fs_grep", {"pattern": pat, "path": "parent_link"}
        yield "fs_grep", {"pattern": pat, "glob": "../**"}
    for pat in ("../**", "/**/secret.txt", "{../scope-canary,notes}/*", "**/../**/secret.txt"):
        yield "fs_glob", {"pattern": pat}


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "relayremote"
    client = Stack() if mode == "relayremote" else Direct(sys.argv[2], sys.argv[3])

    setup()
    before_out = inventory(OUTSIDE)
    before_sent = sentinel_state()
    before_dirs = {d: listing(d) for d in (BWC, os.path.expanduser("~"), "/etc", "/tmp")}
    print(f"mode={mode}  canary files={len(before_out)}")

    leaked, n = [], 0
    plan = list(attacks()) + two_step_overwrite(client)
    for tool, args in plan:
        n += 1
        try:
            reply = client.call(tool, args)
        except subprocess.TimeoutExpired:
            FAILS.append(f"{tool} {args} TIMED OUT")
            continue
        for c in CANARIES:
            if c in reply:
                leaked.append((tool, args, c, reply[:200]))
        if NAME_CANARY in reply:
            leaked.append((tool, args, "filename " + NAME_CANARY, reply[:200]))
        # A host path outside the grant must not appear either.
        if OUTSIDE in reply and "path" not in reply[:0]:
            pass  # the caller supplied it; only canary CONTENT counts as exfiltration

    after_out = inventory(OUTSIDE)
    print(f"\n{n} attack calls made\n")

    print("== EXFILTRATION ==")
    if leaked:
        for tool, args, c, snip in leaked:
            print(f"  LEAK via {tool} {args}: {c}\n    {snip}")
        FAILS.append(f"{len(leaked)} exfiltration(s)")
    else:
        print(f"  PASS  no canary content in any of {n} replies")

    print("\n== DESTRUCTION ==")
    if before_out != after_out:
        for k in set(before_out) | set(after_out):
            if before_out.get(k) != after_out.get(k):
                print(f"  CHANGED {k}: {before_out.get(k)} -> {after_out.get(k)}")
        FAILS.append("out-of-scope tree changed")
    else:
        print(f"  PASS  all {len(before_out)} out-of-scope entries byte-identical")

    print("\n== OVERWRITE OF SENSITIVE FILES ==")
    after_sent = sentinel_state()
    bad = [p for p in SENTINELS if before_sent[p] != after_sent[p]]
    if bad:
        for p in bad:
            print(f"  ALTERED {p}: {before_sent[p]} -> {after_sent[p]}")
        FAILS.append("sentinel file altered")
    else:
        print(f"  PASS  {len(SENTINELS)} sentinel files unchanged in bytes, size and mode")

    print("\n== NEW FILES OUTSIDE THE GRANT ==")
    appeared = {d: listing(d) - before_dirs[d] for d in before_dirs}
    appeared = {d: v for d, v in appeared.items() if v}
    if appeared:
        for d, v in appeared.items():
            print(f"  APPEARED in {d}: {sorted(v)}")
        FAILS.append("new entries outside the grant")
    else:
        print("  PASS  nothing new in %s" % ", ".join(before_dirs))

    for extra, label in ((f"{BWC}/scope-canary/pwned.txt", "pwned.txt in canary dir"),
                         ("/etc/pwned", "/etc/pwned"),
                         (f"{BWC}/pwned.txt", "pwned.txt beside the grant")):
        if os.path.exists(extra):
            print(f"  CREATED {label}")
            FAILS.append(label)

    print("\n%d failure(s)%s" % (len(FAILS), ": " + "; ".join(FAILS) if FAILS else ""))
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
