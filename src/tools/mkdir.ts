import * as fs from 'fs';
import { ToolRegistry, schema, stringProp, boolProp, parseBoolArg, requireStringArg } from '../registry';
import { textResult, errorResult, ToolContext } from '../types';
import { checkPathV, decodeInboundPath, describeError, translateResult } from '../vpath';

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
      const dirPathArg = requireStringArg(args, 'path');
      if (typeof dirPathArg !== 'string') return dirPathArg;

      // Issue #7: decode the client's virtual-space address into the host
      // path checkPath (and everything after it) already expects -- see
      // read.ts for the full reasoning.
      const decoded = decodeInboundPath(dirPathArg, ctx.labels);
      if (typeof decoded !== 'string') return decoded;
      const dirPath = decoded;

      const recursiveArg = parseBoolArg(args.recursive, 'recursive', true);
      if (typeof recursiveArg !== 'boolean') return recursiveArg;
      const recursive = recursiveArg;

      const pathErr = checkPathV(dirPath, ctx.allowedDirs, ctx.labels);
      if (pathErr) return pathErr;

      let existed = false;
      try {
        existed = fs.statSync(dirPath).isDirectory();
      } catch {
        // does not exist yet -- the ordinary case
      }
      if (existed) {
        return translateResult(textResult(`directory already exists: ${dirPath}`), [dirPath], ctx.labels);
      }

      try {
        fs.mkdirSync(dirPath, { recursive });
      } catch (err: unknown) {
        return errorResult(`mkdir failed: ${describeError(err, ctx.labels)}`);
      }

      return translateResult(textResult(`Created directory: ${dirPath}`), [dirPath], ctx.labels);
    }
  );
}
