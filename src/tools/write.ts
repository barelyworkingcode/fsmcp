import * as fs from 'fs';
import * as path from 'path';
import { ToolRegistry, schema, stringProp } from '../registry';
import { textResult, errorResult, ToolContext } from '../types';
import { validatePath } from '../security';

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
      category: 'File System',
    },
    (args: Record<string, unknown>, ctx: ToolContext) => {
      const filePath = args.file_path as string;
      const content = args.content as string;

      if (!path.isAbsolute(filePath)) return errorResult('file_path must be absolute');

      const pathErr = validatePath(filePath, ctx.allowedDirs);
      if (pathErr) return errorResult(pathErr);

      const dir = path.dirname(filePath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, content, 'utf-8');

      const bytes = Buffer.byteLength(content, 'utf-8');
      return textResult(`Wrote ${bytes} bytes to ${filePath}`);
    }
  );
}
