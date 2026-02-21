import { execSync } from 'child_process';
import * as path from 'path';
import { ToolRegistry, schema, stringProp, intProp } from '../registry';
import { textResult, errorResult, ToolContext } from '../types';
import { validatePath } from '../security';

const CWD_MARKER = '___FSMCP_CWD___';
const DEFAULT_TIMEOUT = 120_000;
const MAX_TIMEOUT = 600_000;
const MAX_OUTPUT = 30_000;

let currentCwd = process.cwd();

export function registerBash(registry: ToolRegistry): void {
  registry.register(
    {
      name: 'fs_bash',
      description:
        'Execute a shell command. Working directory persists between calls. Output is truncated at 30000 characters.',
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

      // Validate current cwd against allowed dirs
      const cwdErr = validatePath(currentCwd, ctx.allowedDirs);
      if (cwdErr) return errorResult(`cwd ${currentCwd} is outside allowed directories`);

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

        return processOutput(output, false);
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
          return processOutput(combined, true);
        }
        return errorResult(String(err));
      }
    }
  );
}

function processOutput(raw: string, isError: boolean) {
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

  if (newCwd) {
    currentCwd = newCwd;
  }

  let output = outputLines.join('\n').trimEnd();

  if (output.length > MAX_OUTPUT) {
    output = output.substring(0, MAX_OUTPUT) + '\n... [output truncated]';
  }

  if (isError) {
    return errorResult(output);
  }
  return textResult(output);
}
