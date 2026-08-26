import * as fs from 'fs';
import { ToolRegistry, schema, stringProp, boolProp } from '../registry';
import { textResult, errorResult, ToolContext } from '../types';
import { checkPath } from '../security';

export function registerMkdir(registry: ToolRegistry): void {
  registry.register(
    {
      name: 'fs_mkdir',
      description:
        'Create a directory. Creates missing parent directories too unless recursive is set to false.',
      inputSchema: schema(
        {
          path: stringProp('Absolute path of the directory to create'),
          recursive: boolProp('Create missing parent directories (default: true)'),
        },
        ['path']
      ),
      // Creates a local directory only; never contacts anything off this
      // machine.
      annotations: { readOnlyHint: false, openWorldHint: false },
      category: 'File System',
    },
    (args: Record<string, unknown>, ctx: ToolContext) => {
      const dirPath = args.path as string;
      const recursive = (args.recursive as boolean) ?? true;

      const pathErr = checkPath(dirPath, ctx.allowedDirs);
      if (pathErr) return pathErr;

      let existed = false;
      try {
        existed = fs.statSync(dirPath).isDirectory();
      } catch {
        // does not exist yet -- the ordinary case
      }
      if (existed) return textResult(`directory already exists: ${dirPath}`);

      try {
        fs.mkdirSync(dirPath, { recursive });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return errorResult(`mkdir failed: ${message}`);
      }

      return textResult(`Created directory: ${dirPath}`);
    }
  );
}
