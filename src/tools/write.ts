import * as fs from 'fs';
import * as path from 'path';
import { ToolRegistry, schema, stringProp, requireStringArg } from '../registry';
import { textResult, errorResult, ToolContext } from '../types';
import { checkPath } from '../security';

// C5 ("max bytes on fs_read and fs_write"), same reasoning as fs_read's
// MAX_READ_BYTES: an unbounded write is an unbounded synchronous allocation
// (the whole `content` string, plus whatever V8 needs to convert it to the
// UTF-8 bytes fs.writeFileSync sends to the kernel) in the one process
// every other caller is also waiting on. Checked against the argument's
// byte length before either mkdirSync or writeFileSync runs, so a refusal
// creates nothing -- not even the parent directories.
const MAX_WRITE_BYTES = 10 * 1024 * 1024;

export function registerWrite(registry: ToolRegistry): void {
  registry.register(
    {
      name: 'fs_write',
      description:
        'Write content to a file. Creates the file and parent directories if they do not exist. Overwrites existing files.',
      inputSchema: schema(
        {
          file_path: stringProp('Absolute path to the file'),
          content: stringProp('Content to write'),
        },
        ['file_path', 'content']
      ),
      // Creates/overwrites a local file; never contacts anything off this
      // machine.
      annotations: { readOnlyHint: false, openWorldHint: false },
      category: 'File System',
    },
    (args: Record<string, unknown>, ctx: ToolContext) => {
      const filePathArg = requireStringArg(args, 'file_path');
      if (typeof filePathArg !== 'string') return filePathArg;
      const filePath = filePathArg;

      const contentArg = requireStringArg(args, 'content');
      if (typeof contentArg !== 'string') return contentArg;
      const content = contentArg;

      const pathErr = checkPath(filePath, ctx.allowedDirs);
      if (pathErr) return pathErr;

      const bytes = Buffer.byteLength(content, 'utf-8');
      if (bytes > MAX_WRITE_BYTES) {
        return errorResult(
          `content is ${bytes} bytes, over fs_write's ${MAX_WRITE_BYTES}-byte limit; write it in ` +
            `smaller pieces (e.g. with fs_edit against an existing file) instead`
        );
      }

      const dir = path.dirname(filePath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, content, 'utf-8');

      return textResult(`Wrote ${bytes} bytes to ${filePath}`);
    }
  );
}
