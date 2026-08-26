#!/usr/bin/env python3
"""Layer 3 — can a real agent actually drive the v3 API?

This does NOT test containment, and cannot on this machine. The relayremote
skill is a CLI, so the agent needs a shell toolset, and a shell on this box
reaches the granted files directly without going through relay at all. The
runbook's deployment puts hermes on a separate VM precisely so that shell
cannot reach them; containment is Layers 1-2's job and is proven there.

What this tests is the design risk in v3: mandatory `if_sha256` on every
mutation is unusual, and if an agent cannot work it out then the design is
wrong. Each task is judged by `relay audit` — which proves the work actually
went through relay — and by the resulting bytes on disk.
"""
import json
import os
import subprocess
import sys
import time

RELAY = "/Applications/Relay.app/Contents/MacOS/relay"
GRANT = "/Users/admin/source/barelyworkingcode/testfolder"
SKILL = "relayremote-hermes-v3"

RR = "/Users/admin/.local/bin/relayremote"

# hermes runs on this machine and has a shell, so it can reach the granted
# files directly. Naming the transport and the tool is what forces the call
# through relay; the ARGUMENTS are left for the agent to work out, because
# that is the part worth testing.
PREAMBLE = (
    f"You have a CLI at {RR} that reaches a remote file server. "
    "Every file operation in this task MUST go through it, as:\n"
    f"  {RR} call --tool <TOOL> --args '<JSON>'\n"
    "Do NOT use your own shell file tools (cat, ls, sed, python) to read or write "
    "any file — they would touch the wrong machine and the task would be wrong. "
    f"Run `{RR} list --schema` first if you need a tool's argument shape.\n\n"
)

TASKS = [
    ("discover", PREAMBLE +
     'Call the tool fs_list to list the remote root directory. Report the names.'),
    ("read", PREAMBLE +
     "Call the tool fs_read on the remote file data/latin1.txt. Report the encoding "
     "the server reported and the byte count."),
    ("create", PREAMBLE +
     "Call the tool fs_write to create the remote file layer3/created.txt containing "
     "exactly HELLO-L3. Report the sha256 the server returns."),
    ("edit-precondition", PREAMBLE +
     "Change HELLO-L3 to EDITED-L3 inside the remote file layer3/created.txt, using "
     "the tools fs_stat and fs_replace. Report what you did."),
    ("ambiguity", PREAMBLE +
     "In the remote file layer3/repeat.txt, replace the letter x with y using "
     "fs_replace. If the server refuses, read its message, work out why, and do what "
     "it suggests so that every x becomes y."),
    ("recover", PREAMBLE +
     "Call fs_write to put the text FINAL-L3 into layer3/created.txt. If the server "
     "refuses on a precondition, recover and finish the job."),
]


AUDIT_LOG = os.path.expanduser(
    "~/Library/Application Support/relay/logs/audit/toolcalls.jsonl")


def audit_since(mark):
    """Records for this profile newer than mark. Read from the log rather than
    `relay audit --tail N`, whose window saturates once N calls exist and makes
    every diff zero."""
    out = []
    for line in open(AUDIT_LOG):
        try:
            e = json.loads(line)
        except Exception:
            continue
        if e.get("ts", "") > mark and "v3" in str(e.get("actor", {}).get("project_name", "")):
            out.append(e)
    return out


def main():
    os.makedirs(f"{GRANT}/layer3", exist_ok=True)
    open(f"{GRANT}/layer3/repeat.txt", "w").write("x\nx\nx\n")
    if os.path.exists(f"{GRANT}/layer3/created.txt"):
        os.remove(f"{GRANT}/layer3/created.txt")

    fails = []
    for label, prompt in TASKS:
        mark = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime())
        print(f"\n{'=' * 6} {label} {'=' * 6}")
        try:
            p = subprocess.run(["hermes", "-z", prompt, "--yolo", "--skills", SKILL],
                               capture_output=True, text=True, timeout=300, cwd="/tmp")
            out = p.stdout + p.stderr
        except subprocess.TimeoutExpired:
            print("  TIMED OUT")
            fails.append(label)
            continue
        time.sleep(1)
        new = audit_since(mark)
        print("  agent:", " ".join(out.split())[-240:])
        print(f"  calls through relay: {len(new)}")
        for e in new[:10]:
            if e.get("phase") == "completion":
                print("     %-9s %-11s %s" % (e.get("outcome", e.get("phase")), e.get("tool"),
                                              json.dumps(e.get("args"))[:76]))
        if not new:
            print("  NOTE: nothing reached relay — the agent did not use the skill")
            fails.append(label)

    print("\n===== disk state =====")
    for f in ("layer3/created.txt", "layer3/repeat.txt"):
        path = f"{GRANT}/{f}"
        print(f"  {f}: {open(path).read()!r}" if os.path.exists(path) else f"  {f}: MISSING")

    print("\n%d task(s) did not reach relay%s"
          % (len(fails), ": " + ", ".join(fails) if fails else ""))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
