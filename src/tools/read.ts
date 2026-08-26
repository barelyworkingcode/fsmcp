import * as fs from 'fs';
import * as path from 'path';
import { ToolRegistry, schema, stringProp, intProp, requireStringArg } from '../registry';
import { textResult, errorResult, ToolContext } from '../types';
import { checkPathV, decodeInboundPath, translateResult } from '../vpath';

const IMAGE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico',
]);
const MAX_LINE_LENGTH = 2000;
const DEFAULT_LIMIT = 2000;

// C5 ("max bytes on fs_read and fs_write") named this explicitly and it was
// simply never implemented: every read below loaded the *entire* file into
// memory with fs.readFileSync before offset/limit ever got a chance to trim
// it down to a handful of lines. fsmcp is one synchronous process serving
// every caller; a file this large already sitting inside an allowed_dir (put
// there by the same agent this tool serves, or by anything else with write
// access to that directory) turns an ordinary `fs_read` into a
// multi-hundred-megabyte synchronous allocation that blocks -- and can
// exhaust memory in -- the one process every other caller is also waiting
// on. Checked against `stat.size` (already available before any read is
// attempted) rather than after reading, so the refusal costs nothing.
const MAX_READ_BYTES = 10 * 1024 * 1024;

export function registerRead(registry: ToolRegistry): void {
  registry.register(
    {
      name: 'fs_read',
      description:
        'Read file contents with line numbers (cat -n format). Supports offset and limit for partial reads. Lines longer than 2000 characters are truncated. Refuses files over 10MB -- use fs_grep to search a larger one instead.',
      inputSchema: schema(
        {
          file_path: stringProp('Absolute path to the file'),
          offset: intProp('Line number to start reading from (1-based)'),
          limit: intProp('Maximum number of lines to read (default: 2000)'),
        },
        ['file_path']
      ),
      // Reads a local file only; never contacts anything off this machine.
      annotations: { readOnlyHint: true, openWorldHint: false },
      category: 'File System',
    },
    (args: Record<string, unknown>, ctx: ToolContext): ReturnType<typeof textResult> => {
      const filePathArg = requireStringArg(args, 'file_path');
      if (typeof filePathArg !== 'string') return filePathArg;

      // Issue #7: the client addresses files in the virtual space this call
      // was granted (/<label>/...), never a host path -- decodeInboundPath
      // is the only thing standing between the caller's argument and every
      // check below, and it does not replace any of them: checkPathV runs
      // security.ts's own checkPath, unmodified, on the host path it hands
      // back, and only translates the message THAT returns.
      const decoded = decodeInboundPath(filePathArg, ctx.labels);
      if (typeof decoded !== 'string') return decoded;
      const filePath = decoded;

      const pathErr = checkPathV(filePath, ctx.allowedDirs, ctx.labels);
      if (pathErr) return pathErr;

      let stat: fs.Stats;
      try {
        stat = fs.statSync(filePath);
      } catch {
        return translateResult(errorResult(`file not found: ${filePath}`), [filePath], ctx.labels);
      }

      if (stat.isDirectory()) return errorResult('path is a directory, not a file');

      if (stat.size > MAX_READ_BYTES) {
        return translateResult(
          errorResult(
            `${filePath} is ${stat.size} bytes, over fs_read's ${MAX_READ_BYTES}-byte limit; ` +
              `narrow with offset/limit is not possible because the whole file must be loaded ` +
              `to find line boundaries -- use fs_grep to search it instead`
          ),
          [filePath],
          ctx.labels
        );
      }

      // From here down: real file bytes. Neither this nor the formatted
      // text below is EVER passed through translateResult/hostToVirtual --
      // this is a file's own content, which can legitimately contain
      // something that reads like the sandbox's own host path (a config, a
      // log, a script mentioning its own location), and must reach the
      // caller byte for byte regardless (PR #10 review: a whole-result
      // rewrite used to run here too, and a write-then-read round trip
      // showed it silently corrupting exactly this case).
      // Image files: return base64
      const ext = path.extname(filePath).toLowerCase();
      if (IMAGE_EXTENSIONS.has(ext)) {
        const data = fs.readFileSync(filePath);
        return textResult(`[base64 image: ${ext}]\n${data.toString('base64')}`);
      }

      const content = fs.readFileSync(filePath, 'utf-8');
      const allLines = content.split('\n');

      const offset = Math.max(1, (args.offset as number) ?? 1);
      const limit = (args.limit as number) ?? DEFAULT_LIMIT;
      const startIdx = offset - 1;
      const lines = allLines.slice(startIdx, startIdx + limit);

      const maxLineNum = startIdx + lines.length;
      const numWidth = Math.max(String(maxLineNum).length, 1);

      const formatted = lines
        .map((line, i) => {
          const lineNum = String(startIdx + i + 1).padStart(numWidth);
          const truncated =
            line.length > MAX_LINE_LENGTH
              ? line.substring(0, MAX_LINE_LENGTH) + '... [truncated]'
              : line;
          return `${lineNum}\t${truncated}`;
        })
        .join('\n');

      return textResult(formatted);
    }
  );
}
