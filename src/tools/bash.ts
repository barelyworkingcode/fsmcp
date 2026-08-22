import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { ToolRegistry, schema, stringProp, intProp } from '../registry';
import { textResult, errorResult, ToolContext } from '../types';
import { validatePath } from '../security';

const CWD_MARKER = '___FSMCP_CWD___';
const DEFAULT_TIMEOUT = 120_000;
const MAX_TIMEOUT = 600_000;
const MAX_OUTPUT = 30_000;

/**
 * The shell's working directory, carried between calls.
 *
 * This is only ever assigned a directory that passed validatePath at the
 * moment it was assigned -- see the two guards below. It used to be assigned
 * whatever `pwd` reported after the command ran, unvalidated, which turned
 * one stray `cd` into a permanent outage: the *next* call's entry check
 * refused, and it refused every call after it including the `cd` that would
 * have undone it, because the refusal happens before the command runs. One
 * `cd /etc` disabled fs_bash for the life of the process.
 *
 * Note this is not a sandbox escape being fixed. fs_bash runs an arbitrary
 * shell; allowed_dirs was never a boundary for it (which is why relay filters
 * it out of every project rather than relying on one), and a command can
 * reach any path with or without a `cd`. What was broken is availability: a
 * tool that cannot be recovered without restarting the server.
 */
let currentCwd = process.cwd();

/**
 * The first allowed directory that exists and is a directory, to fall back
 * to when `currentCwd` is not usable. Returns null when the scope offers
 * nothing -- e.g. it is empty, which validatePath treats as "refuse all".
 */
function firstUsableDir(allowedDirs: string[]): string | null {
  for (const dir of allowedDirs) {
    if (validatePath(dir, allowedDirs) !== null) continue;
    try {
      if (fs.statSync(dir).isDirectory()) return dir;
    } catch {
      // does not exist or is not readable; try the next one
    }
  }
  return null;
}

export function registerBash(registry: ToolRegistry): void {
  registry.register(
    {
      name: 'fs_bash',
      description:
        'Execute a shell command. Working directory persists between calls, as long as it stays within the allowed directories -- a cd that leaves them is not carried over to the next call. Output is truncated at 30000 characters.',
      inputSchema: schema(
        {
          command: stringProp('Shell command to execute'),
          timeout: intProp('Timeout in milliseconds (default: 120000, max: 600000)'),
          description: stringProp('Description of what the command does'),
        },
        ['command']
      ),
      category: 'Shell',
    },
    (args: Record<string, unknown>, ctx: ToolContext) => {
      const command = args.command as string;
      const timeout = Math.min((args.timeout as number) ?? DEFAULT_TIMEOUT, MAX_TIMEOUT);

      // Validate the carried cwd against allowed dirs. A cwd that does not
      // pass is *recovered from*, not refused: refusing here refuses the
      // command that would fix it, so this used to be a one-way door. It is
      // still reachable even though nothing out of scope is ever stored --
      // the server may have been started from outside the scope (in which
      // case fs_bash was dead on arrival, every call including the first
      // refused), and allowed_dirs arrives per-call via _meta, so a caller
      // can narrow the scope out from under a cwd that was fine when it was
      // stored.
      const notes: string[] = [];
      if (validatePath(currentCwd, ctx.allowedDirs) !== null) {
        const fallback = firstUsableDir(ctx.allowedDirs);
        if (fallback === null) {
          return errorResult(
            `cwd ${currentCwd} is outside allowed directories, and no allowed directory ` +
              `is usable as a replacement`
          );
        }
        notes.push(
          `[fsmcp: working directory ${currentCwd} is outside the allowed directories; ` +
            `reset to ${fallback}]`
        );
        currentCwd = fallback;
      }

      // Append cwd marker to track directory changes
      const wrappedCommand = `${command}\necho "${CWD_MARKER}$(pwd)"`;

      try {
        const output = execSync(wrappedCommand, {
          cwd: currentCwd,
          shell: '/bin/bash',
          timeout,
          maxBuffer: 10 * 1024 * 1024,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env },
        });

        return processOutput(output, false, ctx.allowedDirs, notes);
      } catch (err: unknown) {
        if (err && typeof err === 'object') {
          const execErr = err as {
            stdout?: string;
            stderr?: string;
            status?: number;
          };
          const combined = [execErr.stdout ?? '', execErr.stderr ?? '']
            .filter(Boolean)
            .join('\n');
          return processOutput(combined, true, ctx.allowedDirs, notes);
        }
        return errorResult(String(err));
      }
    }
  );
}

function processOutput(
  raw: string,
  isError: boolean,
  allowedDirs: string[],
  notes: string[],
) {
  const lines = raw.split('\n');

  // Find and extract cwd marker
  let newCwd: string | null = null;
  const outputLines: string[] = [];

  for (const line of lines) {
    const markerIdx = line.indexOf(CWD_MARKER);
    if (markerIdx !== -1) {
      const cwdValue = line.substring(markerIdx + CWD_MARKER.length).trim();
      if (cwdValue && path.isAbsolute(cwdValue)) {
        newCwd = cwdValue;
      }
      // Include any content before the marker
      const before = line.substring(0, markerIdx);
      if (before.trim()) outputLines.push(before);
    } else {
      outputLines.push(line);
    }
  }

  // Only a cwd that is in scope is carried to the next call. The command has
  // already run and the `cd` already took effect for its own duration -- that
  // cannot be undone from here and is not what this guards. What it guards is
  // that the next call starts somewhere it is allowed to start, so a `cd` out
  // of scope costs the caller that one command's worth of directory and
  // nothing more.
  if (newCwd && newCwd !== currentCwd) {
    if (validatePath(newCwd, allowedDirs) !== null) {
      notes.push(
        `[fsmcp: the command left the working directory at ${newCwd}, which is outside ` +
          `the allowed directories; it was not carried over -- the next call runs in ` +
          `${currentCwd}]`
      );
    } else {
      currentCwd = newCwd;
    }
  }

  let output = outputLines.join('\n').trimEnd();

  if (output.length > MAX_OUTPUT) {
    output = output.substring(0, MAX_OUTPUT) + '\n... [output truncated]';
  }

  // Notes go after any truncation so they survive it. They are advisory: a
  // command that succeeded still reports success.
  if (notes.length > 0) {
    output = output ? `${output}\n${notes.join('\n')}` : notes.join('\n');
  }

  if (isError) {
    return errorResult(output);
  }
  return textResult(output);
}
