import { execFileSync } from 'node:child_process';
import { ESLint } from 'eslint';
import ts from 'typescript';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
const files = git('diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z').split('\0').filter(Boolean);
const eslint = new ESLint();
const results = [];
let failed = false;
for (const file of files) {
  if (!/\.(?:[cm]?[jt]sx?|json)$/.test(file)) continue;
  const source = git('show', `:${file}`);
  if (file.endsWith('.json')) {
    try { JSON.parse(source); }
    catch (error) { console.error(`${file}: ${error.message}`); failed = true; }
    continue;
  }
  // Parse even files intentionally excluded from style rules. Read the index,
  // not the worktree: an unstaged fix must not hide a broken staged version.
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  for (const diagnostic of parsed.parseDiagnostics) {
    const { line, character } = parsed.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
    console.error(`${file}:${line + 1}:${character + 1}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`);
    failed = true;
  }
  if (!await eslint.isPathIgnored(file)) {
    results.push(...await eslint.lintText(source, { filePath: file }));
  }
}
const output = (await eslint.loadFormatter('stylish')).format(results);
if (output) console.log(output);
if (failed || results.some(result => result.errorCount > 0)) process.exitCode = 1;
