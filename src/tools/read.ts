import * as fs from 'fs';
import * as path from 'path';
import { ToolRegistry, schema, stringProp, intProp } from '../registry';
import { textResult, errorResult, ToolContext } from '../types';
import { validatePath } from '../security';

const IMAGE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico',
]);
const MAX_LINE_LENGTH = 2000;
const DEFAULT_LIMIT = 2000;

export function registerRead(registry: ToolRegistry): void {
  registry.register(
    {
      name: 'fs_read',
      description:
        'Read file contents with line numbers (cat -n format). Supports offset and limit for partial reads. Lines longer than 2000 characters are truncated.',
      inputSchema: schema(
        {
          file_path: stringProp('Absolute path to the file'),
          offset: intProp('Line number to start reading from (1-based)'),
          limit: intProp('Maximum number of lines to read (default: 2000)'),
        },
        ['file_path']
      ),
      annotations: { readOnlyHint: true },
      category: 'File System',
    },
    (args: Record<string, unknown>, ctx: ToolContext): ReturnType<typeof textResult> => {
      const filePath = args.file_path as string;

      const pathErr = validatePath(filePath, ctx.allowedDirs);
      if (pathErr) return errorResult(pathErr);

      if (!path.isAbsolute(filePath)) return errorResult('file_path must be absolute');

      let stat: fs.Stats;
      try {
        stat = fs.statSync(filePath);
      } catch {
        return errorResult(`file not found: ${filePath}`);
      }

      if (stat.isDirectory()) return errorResult('path is a directory, not a file');

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
