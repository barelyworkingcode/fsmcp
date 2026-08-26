import * as fs from 'fs';
import { ToolRegistry, schema, stringProp, boolProp, parseBoolArg, requireStringArg } from '../registry';
import { textResult, errorResult, ToolContext } from '../types';
import { checkPath } from '../security';

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
      // Mutates a local file in place; never contacts anything off this
      // machine.
      annotations: { readOnlyHint: false, openWorldHint: false },
      category: 'File System',
    },
    (args: Record<string, unknown>, ctx: ToolContext) => {
      const filePathArg = requireStringArg(args, 'file_path');
      if (typeof filePathArg !== 'string') return filePathArg;
      const filePath = filePathArg;

      const oldStringArg = requireStringArg(args, 'old_string');
      if (typeof oldStringArg !== 'string') return oldStringArg;
      const oldString = oldStringArg;

      // Checked explicitly rather than left to `parts.join(newString)`:
      // `Array.prototype.join` stringifies a `null` new_string to the
      // literal text "null" and writes it into the file with no error at
      // all (unlike `undefined`, which join treats as "use the default
      // separator" -- the two are not equivalent here even though `as
      // string` cannot tell them apart). A wrong-typed old_string throws
      // instead (content.split has no such special case), which is also
      // wrong, just louder -- this check catches both the same way.
      const newStringArg = requireStringArg(args, 'new_string');
      if (typeof newStringArg !== 'string') return newStringArg;
      const newString = newStringArg;

      const replaceAllArg = parseBoolArg(args.replace_all, 'replace_all', false);
      if (typeof replaceAllArg !== 'boolean') return replaceAllArg;
      const replaceAll = replaceAllArg;

      const pathErr = checkPath(filePath, ctx.allowedDirs);
      if (pathErr) return pathErr;

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
