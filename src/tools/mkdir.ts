import * as fs from 'fs';
import { ToolRegistry, schema, stringProp, boolProp, parseBoolArg, requireStringArg, virtualPathDescription } from '../registry';
import { textResult, errorResult, ToolContext } from '../types';
import { checkPathV, decodeInboundPath, describeError, refuseAllowedDirRootWriteV, translateResult } from '../vpath';

export function registerMkdir(registry: ToolRegistry): void {
  registry.register(
    {
      name: 'fs_mkdir',
      description:
        'Create a directory. Creates missing parent directories too unless recursive is set to false.',
      inputSchema: schema(
        {
          path: stringProp(virtualPathDescription()),
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

      // Issue #24: the write-side half of the allowed_dir-root rule
      // (security.ts's refuseAllowedDirRootWrite) applies to fs_mkdir too,
      // and it is a real hole here, not a formality. `fs.mkdirSync(dirPath,
      // { recursive: true })` creates every MISSING ANCESTOR of its
      // argument, so against a grant whose root does not exist yet,
      // `fs_mkdir { path: "/d0" }` creates the grant's parent -- a
      // directory outside allowed_dirs -- and answers "Created directory:
      // /d0" as though nothing else had happened. Reproduced exactly that
      // way. `checkPathV` above passes it because a root is inside itself.
      //
      // Refused for the resolved root whether or not it currently exists,
      // rather than only in the case that creates something: an
      // existence-conditional rule would be a second, weaker version of the
      // same rule, decided by a stat that can be raced, and the answer
      // "your grant root already exists" was never useful to a caller
      // anyway. The refusal is a scope violation for the same reason
      // fs_write's is -- servicing it puts a directory outside the grant.
      const rootErr = refuseAllowedDirRootWriteV(dirPath, ctx.allowedDirs, 'create', ctx.labels);
      if (rootErr) return rootErr;

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
