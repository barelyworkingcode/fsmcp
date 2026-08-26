import * as fs from 'fs';
import { ToolRegistry, schema, stringProp, boolProp, parseBoolArg, requireStringArg, virtualPathDescription } from '../registry';
import { textResult, errorResult, ToolContext } from '../types';
import { checkPathV, decodeInboundPath, translateResult } from '../vpath';
import { decodeUtf8Strict, hasLoneSurrogate } from '../encoding';

export function registerEdit(registry: ToolRegistry): void {
  registry.register(
    {
      name: 'fs_edit',
      description:
        'Perform exact string replacement in a file. By default, old_string must appear exactly once (fails if 0 or >1 matches). Use replace_all to replace every occurrence.',
      inputSchema: schema(
        {
          file_path: stringProp(virtualPathDescription()),
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

      // Issue #7: decode the client's virtual-space address into the host
      // path checkPath (and everything after it) already expects -- see
      // read.ts for the full reasoning.
      const decoded = decodeInboundPath(filePathArg, ctx.labels);
      if (typeof decoded !== 'string') return decoded;
      const filePath = decoded;

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

      const pathErr = checkPathV(filePath, ctx.allowedDirs, ctx.labels);
      if (pathErr) return pathErr;

      // A lone UTF-16 surrogate in new_string cannot be encoded as valid
      // UTF-8 at all (see encoding.ts's hasLoneSurrogate doc) -- refused
      // before the file is even opened, unconditionally, the same as
      // fs_write's identical check on `content`: there is no lossy-but-
      // intentional reading of it to honour, because Node's UTF-8 encoder
      // would silently substitute U+FFFD for it on write.
      if (hasLoneSurrogate(newString)) {
        return errorResult(
          'new_string contains a lone (unpaired) UTF-16 surrogate, which has no valid UTF-8 ' +
            'encoding -- writing it would silently substitute U+FFFD for it. This usually means ' +
            'new_string was already corrupted before it reached fs_edit; re-derive it from the ' +
            'original source rather than writing it as-is.'
        );
      }

      let raw: Buffer;
      try {
        raw = fs.readFileSync(filePath);
      } catch {
        return translateResult(errorResult(`file not found: ${filePath}`), [filePath], ctx.labels);
      }

      // fs_edit is defined over text: it finds a literal string and
      // replaces it, which has no meaning against bytes that are not text
      // in the first place. Reading with fs.readFileSync(path, 'utf-8')
      // used to answer that question by silently substituting U+FFFD for
      // every byte that failed to decode (issue #11) and then writing the
      // substituted string straight back with fs.writeFileSync(...,
      // 'utf-8') -- corrupting the file on every edit, even one whose
      // old_string/new_string were both correct, because the write step
      // re-encodes the ALREADY-LOSSY in-memory string. Refusing here is not
      // "binary is dangerous"; it is "this operation does not apply to
      // content that cannot be represented as UTF-8 text" -- the same
      // representability question decodeUtf8Strict answers everywhere else
      // in this codebase. There is no base64 escape hatch for fs_edit the
      // way there is for fs_read/fs_write: a byte-level splice is not a
      // string replacement, and fsMCP does not invent a new operation here
      // to paper over that.
      let content: string;
      try {
        content = decodeUtf8Strict(raw);
      } catch {
        return translateResult(
          errorResult(
            `${filePath}'s bytes are not valid UTF-8, so fs_edit cannot represent them as text to ` +
              `edit. Use fs_read with encoding: "base64" to inspect it; fs_edit has no way to ` +
              `perform a literal-string edit against non-UTF-8 content.`
          ),
          [filePath],
          ctx.labels
        );
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

      return translateResult(
        textResult(`Replaced ${count} occurrence(s) in ${filePath}`),
        [filePath],
        ctx.labels
      );
    }
  );
}
