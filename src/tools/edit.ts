import * as fs from 'fs';
import * as path from 'path';
import { ToolRegistry, schema, stringProp, boolProp } from '../registry';
import { textResult, errorResult, ToolContext } from '../types';
import { validatePath } from '../security';

export function registerEdit(registry: ToolRegistry): void {
  registry.register(
    {
      name: 'fs_edit',
      description:
        'Perform exact string replacement in a file. By default, old_string must appear exactly once (fails if 0 or >1 matches). Use replace_all to replace every occurrence.',
      inputSchema: schema(
        {
          file_path: stringProp('Absolute path to the file'),
          old_string: stringProp('Exact string to find'),
          new_string: stringProp('Replacement string'),
          replace_all: boolProp('Replace all occurrences (default: false)'),
        },
        ['file_path', 'old_string', 'new_string']
      ),
      category: 'File System',
    },
    (args: Record<string, unknown>, ctx: ToolContext) => {
      const filePath = args.file_path as string;
      const oldString = args.old_string as string;
      const newString = args.new_string as string;
      const replaceAll = (args.replace_all as boolean) ?? false;

      if (!path.isAbsolute(filePath)) return errorResult('file_path must be absolute');

      const pathErr = validatePath(filePath, ctx.allowedDirs);
      if (pathErr) return errorResult(pathErr);

      let content: string;
      try {
        content = fs.readFileSync(filePath, 'utf-8');
      } catch {
        return errorResult(`file not found: ${filePath}`);
      }

      // Count occurrences
      const parts = content.split(oldString);
      const count = parts.length - 1;

      if (count === 0) {
        return errorResult('old_string not found in file');
      }

      if (!replaceAll && count > 1) {
        return errorResult(
          `old_string found ${count} times. Use replace_all or provide more context to make it unique.`
        );
      }

      const newContent = parts.join(newString);
      fs.writeFileSync(filePath, newContent, 'utf-8');

      return textResult(`Replaced ${count} occurrence(s) in ${filePath}`);
    }
  );
}
