import { readFile, writeFile, mkdir, readdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

export const UPSTREAM = '85b080aafe2f7e3aaf720e5a2ffdf035289c49c1';
const ui = 'src/components/ui';
const primitives = new Set(['Dialog', 'Popover', 'DropdownMenu', 'ContextMenu', 'Tooltip', 'HoverCard']);
const tags = { button: 'Button', input: 'Input', textarea: 'Textarea', select: 'Select', table: 'Table' };

/** Offset edits preserve unrelated formatting, action functions and auth code. */
export function migrateSource(source, filename, { controls = true, legacyComposition = false } = {}) {
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, filename.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.JS);
  const edits = [];
  const imports = new Map();
  const identifiers = new Set();
  function collect(node) { if (ts.isIdentifier(node)) identifiers.add(node.text); ts.forEachChild(node, collect); }
  collect(ast);
  function alias(tag) {
    if (imports.has(tag)) return imports.get(tag);
    let name = `Beui${tags[tag]}`;
    while (identifiers.has(name)) name += '_';
    identifiers.add(name); imports.set(tag, name); return name;
  }
  function edit(node, text) { edits.push({ start: node.getStart(ast), end: node.getEnd(), text }); }
  function visit(node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === 'radix-ui') {
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        const selected = bindings.elements.filter(e => primitives.has((e.propertyName ?? e.name).text));
        const retained = bindings.elements.filter(e => !selected.includes(e));
        if (selected.length) {
          const prefix = node.importClause?.isTypeOnly ? 'type ' : '';
          const parts = [`import ${prefix}{ ${selected.map(e => e.getText(ast)).join(', ')} } from '@/components/ui/primitives';`];
          const defaultName = node.importClause?.name?.text;
          if (retained.length || defaultName) parts.push(`import ${prefix}${defaultName ? defaultName + (retained.length ? ', ' : '') : ''}${retained.length ? '{ ' + retained.map(e => e.getText(ast)).join(', ') + ' }' : ''} from 'radix-ui';`);
          edit(node, parts.join('\n')); return;
        }
      }
    }
    if (ts.isStringLiteral(node) && /^@asharca\/ui(?:\/[^/]*)?$/.test(node.text)) {
      const segment = node.text.slice('@asharca/ui'.length);
      const targets = { '/controls': '/Controls', '/dialog': '/Dialog', '/forms': '/Forms' };
      edit(node, JSON.stringify(`@/components/ui${targets[segment] ?? ''}`));
    }
    if (controls && (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxClosingElement(node))) {
      const tag = node.tagName.getText(ast);
      if (tags[tag]) {
        edit(node.tagName, alias(tag));
        if (tag === 'button' && !ts.isJsxClosingElement(node)) {
          // Preserve intrinsic submit defaults, including spread/dynamic undefined types.
          edits.push({ start: node.tagName.end, end: node.tagName.end, text: ' nativeButton unstyled' });
        }
      }
    }
    if (legacyComposition && ts.isCallExpression(node) && ['_jsx', '_jsxs'].includes(node.expression.getText(ast)) && ts.isStringLiteral(node.arguments[0]) && tags[node.arguments[0].text]) {
      const tag = node.arguments[0].text;
      edit(node.arguments[0], alias(tag));
      if (tag === 'button') {
        const arg = node.arguments[1];
        if (!arg) throw new Error(`Missing JSX props: ${filename}`);
        edits.push({ start: arg.getStart(ast), end: arg.getStart(ast), text: 'Object.assign({ nativeButton: true, unstyled: true }, ' });
        edits.push({ start: arg.end, end: arg.end, text: ')' });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  if (imports.size) {
    let offset = 0;
    for (const statement of ast.statements) {
      if (ts.isExpressionStatement(statement) && ts.isStringLiteral(statement.expression)) offset = statement.end;
      else break;
    }
    edits.push({ start: offset, end: offset, text: `\nimport { ${[...imports].map(([tag, name]) => `${tags[tag]} as ${name}`).join(', ')} } from '@/components/ui/Controls';\n` });
  }
  edits.sort((a, b) => b.start - a.start || b.end - a.end);
  for (const e of edits) source = source.slice(0, e.start) + e.text + source.slice(e.end);
  return source;
}

async function save(filename, source) { await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, source); }
async function walk(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(target)); else files.push(target);
  }
  return files;
}
function replaceOne(source, from, to, filename) {
  if (source.split(from).length !== 2) throw new Error(`Source contract changed: ${filename}: ${from.slice(0, 50)}`);
  return source.replace(from, to);
}
export function adaptInput(source) {
  const filename = 'beui/input';
  source = replaceOne(source, 'type InputHTMLAttributes,', 'type InputHTMLAttributes,\n  type ChangeEventHandler,', filename);
  source = replaceOne(source, '  label?: string;', '  /** Native form bridge; see provenance.json. */\n  nativeLayout?: boolean;\n  onNativeChange?: ChangeEventHandler<HTMLInputElement>;\n  label?: string;', filename);
  source = replaceOne(source, '    onChange,\n', '    onChange,\n    onNativeChange,\n    nativeLayout = false,\n', filename);
  source = replaceOne(source, '  const controlled = valueProp !== undefined;\n  const [internal, setInternal] = useState(defaultValue ?? "");\n  const value = controlled ? (valueProp ?? "") : internal;\n', '', filename);
  source = replaceOne(source, '    if (!controlled) setInternal(next);\n', '', filename);
  const start = source.indexOf('        <input\n');
  const end = source.indexOf('\n        />', start) + '\n        />'.length;
  if (start < 0 || end <= start) throw new Error('Registry Input element missing');
  const input = source.slice(start, end)
    .replace('value={value}', 'value={valueProp}\n          defaultValue={defaultValue}')
    .replace('onChange={(e) => handleChange(e.target.value)}', 'onChange={(e) => { onNativeChange?.(e); handleChange(e.currentTarget.value); }}');
  source = source.slice(0, start) + '        {inputElement}' + source.slice(end);
  source = replaceOne(source, '  return (\n    <div', `  const inputElement = (\n${input}\n  );\n  if (nativeLayout) return inputElement;\n\n  return (\n    <div`, filename);
  return source;
}

async function vendorRegistry() {
  const seen = new Set(); const provenance = [];
  const known = { 'components/motion/button/base.tsx': '68095cc67d0d8b95f84f2cad184bc38e63d64828', 'components/motion/input.tsx': '38c30fee677bb1cdbeb56fe4ba457a4cad3988ad' };
  async function fetchSource(relative) {
    if (!/^(components|lib)\//.test(relative) || relative.split('/').includes('..')) throw new Error('Unsafe registry path');
    if (seen.has(relative)) return;
    seen.add(relative);
    const url = `https://raw.githubusercontent.com/asharca/ui/${UPSTREAM}/${relative}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`${url}: ${response.status}`);
    let source = await response.text();
    const bytes = Buffer.from(source); const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    if (known[relative] && known[relative] !== blob) throw new Error(`Registry hash mismatch ${relative}`);
    const originalSha256 = createHash('sha256').update(source).digest('hex');
    if (relative === 'components/motion/input.tsx') source = adaptInput(source);
    const importPaths = [...source.matchAll(/(?:from\s*|import\s*)["'](@\/[^"']+)["']/g)].map(m => m[1]);
    for (const specifier of new Set(importPaths)) {
      const bare = specifier.slice(2);
      let target;
      for (const candidate of [bare, `${bare}.ts`, `${bare}.tsx`, `${bare}/index.tsx`]) {
        if (!/\.[cm]?[jt]sx?$/.test(candidate)) continue;
        const check = await fetch(`https://raw.githubusercontent.com/asharca/ui/${UPSTREAM}/${candidate}`, { method: 'HEAD', signal: AbortSignal.timeout(30000) });
        if (check.ok) { target = candidate; break; }
      }
      if (!target) throw new Error(`Missing registry helper: ${specifier}`);
      await fetchSource(target);
      let mapped = path.posix.relative(path.posix.dirname(relative), target).replace(/\.[jt]sx?$/, '');
      if (!mapped.startsWith('.')) mapped = './' + mapped;
      source = source.split(specifier).join(mapped);
    }
    const header = '// Source: asharca/ui ' + UPSTREAM + '/' + relative + ' (MIT). See provenance.json.\n';
    await save(`${ui}/beui/${relative}`, header + source);
    provenance.push({ path: relative, upstreamBlob: blob, sha256: originalSha256, adapted: relative.endsWith('/input.tsx') ? ['nativeLayout for existing field layouts', 'onNativeChange forwards the actual React event', 'uncontrolled native value/defaultValue preserves form reset'] : ['relative helper imports'] });
  }
  await fetchSource('components/motion/button/base.tsx');
  await fetchSource('components/motion/input.tsx');
  let license;
  for (const name of ['LICENSE', 'LICENSE.md']) {
    const result = await fetch(`https://raw.githubusercontent.com/asharca/ui/${UPSTREAM}/${name}`, { signal: AbortSignal.timeout(30000) });
    if (result.ok) { license = await result.text(); break; }
  }
  if (!license) throw new Error('Upstream license is required');
  await save(`${ui}/beui/LICENSE`, license);
  await save(`${ui}/beui/provenance.json`, JSON.stringify({ source: 'https://asharca.github.io/ui/llms.txt', repository: 'asharca/ui', commit: UPSTREAM, files: provenance.sort((a,b) => a.path.localeCompare(b.path)) }, null, 2) + '\n');
}

async function preserveCompositions() {
  // Application-specific assistant-ui, routing and layout adapters, NOT new registry primitives.
  const require = createRequire(import.meta.url);
  const packageRoot = path.dirname(path.dirname(require.resolve('@asharca/ui')));
  const manifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  if (manifest.version !== '0.2.1') throw new Error('Unexpected old UI version');
  const modules = [];
  for (const name of await readdir(path.join(packageRoot, 'dist'))) {
    if (!/\.(js|d\.ts)$/.test(name) || /^(Controls|Dialog|Forms|index)\./.test(name)) continue;
    let source = await readFile(path.join(packageRoot, 'dist', name), 'utf8');
    source = source.replaceAll('./Controls.js', '../Controls').replaceAll('./Dialog.js', '../Dialog').replaceAll('./Forms.js', '../Forms');
    if (name.endsWith('.js')) {
      source = migrateSource(source, name, { legacyComposition: true });
      modules.push(name.slice(0, -3));
      source = '// Application composition port from @asharca/ui@0.2.1 (MIT). See NOTICE.md.\n' + source;
    }
    await save(`${ui}/compositions/${name}`, source);
  }
  await copyFile(path.join(packageRoot, 'LICENSE'), `${ui}/compositions/LICENSE`);
  await save(`${ui}/compositions/NOTICE.md`, '# Preserved application compositions\n\nThese JavaScript modules and declaration contracts originate in MIT-licensed `@asharca/ui@0.2.1`. They preserve assistant-ui streaming, navigation state and application-specific layout. Interactive primitives are redirected to the new registry-backed Controls and accessibility adapters. They are not presented as new beUI registry components. The old npm dependency is removed.\n\nChange application-specific behavior here; change visual primitives in the typed adapters or pinned registry source. Upstream copyright is retained in LICENSE.\n');
  await save(`${ui}/index.ts`, `export * from './Controls';\nexport * from './Dialog';\nexport * from './Forms';\n${modules.sort().map(name => `export * from './compositions/${name}.js';`).join('\n')}\n`);
  await save(`${ui}/NativeSelect.tsx`, "export { NativeSelect, type NativeSelectProps } from './Controls';\n");
  let styles = await readFile(path.join(packageRoot, 'src/styles.css'), 'utf8');
  styles = styles.replace(/^@source[^\n]*\n/gm, '');
  // Do not reintroduce scoped token resets; all UI must inherit the app theme.
  styles = styles.replace(/[^{}]+\{[^{}]*--background:\s*var\(--toolplane-ui-background[^{}]*\}/g, '');
  await save(`${ui}/composition-layout.css`, '/* Application layout contracts, adapted from @asharca/ui@0.2.1; see compositions/LICENSE. */\n' + styles);
}

export async function main() {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  if (pkg.dependencies['@asharca/ui'] !== '0.2.1') throw new Error('Migration already applied or unexpected baseline');
  await preserveCompositions(); await vendorRegistry();
  let modified = 0;
  for (const file of [...await walk('src'), ...await walk('tests')]) {
    if (file.startsWith(`${ui}/`) || !/\.[jt]sx?$/.test(file)) continue;
    const source = await readFile(file, 'utf8');
    const next = migrateSource(source, file, { controls: file.startsWith('src/') && file.endsWith('.tsx') });
    if (next !== source) { await writeFile(file, next); modified++; }
  }
  let css = await readFile('src/app/globals.css', 'utf8');
  css = replaceOne(css, '@import "@asharca/ui/styles.css";', '@import "../components/ui/composition-layout.css";\n@import "../components/ui/beui-overrides.css";', 'globals.css');
  // Preserve HSL consumers instead of mixing OKLCH values with hsl(var(...)).
  css = css.replace(/--primary: [^;]+;/g, '--primary: 208 98% 43%;').replace(/--primary-foreground: [^;]+;/g, '--primary-foreground: 0 0% 100%;').replace(/--ring: [^;]+;/g, '--ring: 208 98% 43%;');
  await writeFile('src/app/globals.css', css);
  let vitest = await readFile('vitest.config.ts', 'utf8');
  vitest = vitest.replace(/\s*\/\/ Keep React hook mocks effective inside the published UI package\.\n\s*server: \{ deps: \{ inline: \['@asharca\/ui'\] \} \},/, '');
  await writeFile('vitest.config.ts', vitest);
  let eslint = await readFile('eslint.config.mjs', 'utf8');
  eslint = eslint.replace('  // Override default ignores', `  // Generated application-composition ports retain their published semantics.\n  { files: ['src/components/ui/compositions/**/*.js'], rules: { '@typescript-eslint/no-unused-vars': 'off', '@typescript-eslint/no-this-alias': 'off', 'react-hooks/set-state-in-effect': 'off' } },\n  // Pinned registry effects synchronize media queries and validation feedback.\n  { files: ['src/components/ui/beui/**/*.{ts,tsx}', 'src/components/ui/Forms.tsx'], rules: { 'react-hooks/set-state-in-effect': 'off' } },\n  // Override default ignores`);
  await writeFile('eslint.config.mjs', eslint);
  const agents = await readFile('AGENTS.md', 'utf8');
  await writeFile('AGENTS.md', agents.replace('use published `@asharca/ui`. Change shared components/styles in `asharca/ui`, then update the pinned dependency through a PR. Do not recreate `packages/ui` or alias imports to local UI source.', 'use the source registry selected by the user at `https://asharca.github.io/ui/llms.txt`. Components live under `src/components/ui`; provenance records the pinned upstream commit and documented adaptations. Do not restore the retired npm package or alias its name to local source. Preserve native form semantics and headless accessibility contracts.'));
  await save('docs/UI_LIBRARY.md', '# UI library\n\nThe platform uses the source registry selected at https://asharca.github.io/ui/llms.txt, pinned to `'+UPSTREAM+'`. The former `@asharca/ui@0.2.1` npm package is not the same catalog and has been removed.\n\n## Ownership and architecture\n\n- `src/components/ui/beui`: pinned registry Button, Input and their helpers, MIT license and file hashes.\n- `Controls.tsx`: form-compatible application adapters. Native events, refs, reset, required validation, multiple selection, form association and drag-and-drop are preserved.\n- `Dialog.tsx` and `primitives.tsx`: beUI surface/motion styling over existing Radix headless focus, dismissal and keyboard primitives. Aesthetic reuse does not justify replacing a proven focus stack with a partial custom trap.\n- `compositions`: explicitly attributed, application-specific assistant-ui and layout ports. These retain chat streaming and navigation state; they are not claimed to be registry components.\n- `composition-layout.css` retains geometry; `beui-overrides.css` owns the new visual treatment. All controls inherit the app theme.\n\n## Verification\n\nRun `pnpm exec tsc --noEmit`, `pnpm lint`, `pnpm test`, `pnpm build` and `pnpm runtime:assemble`. New contract tests cover real form events/reset, disabled links, confirmation, keyboard focus and native drag events. API/auth/DB/approval logic is unchanged. Existing functionality regressions must be fixed, not skipped. Actual CLI/model and production integrations remain separate acceptance checks.\n\nThe migration script uses AST offset edits and a fixed upstream commit. It is a one-time migration and refuses an already migrated package. Keep future source updates explicit and update provenance.\n');
  await save('docs/UI_LIBRARY.zh-CN.md', '# UI 组件库\n\n本轮按用户明确选择迁移到 https://asharca.github.io/ui/llms.txt 的源码组件目录，不再使用旧 `@asharca/ui@0.2.1` npm 包。\n\n源码固定提交、文件哈希和适配说明见 `src/components/ui/beui/provenance.json`。所有应用按钮、输入、选择框和表格通过 `src/components/ui/Controls.tsx`；弹窗和浮层采用统一 beUI 外观，保留 Radix 的焦点、键盘及嵌套关闭机制。原生表单事件、FormData、重置、校验、文件上传和拖放不能因为视觉替换而改变。\n\n`compositions` 是明确保留来源及许可证的应用组合层，用于维持 assistant-ui 消息流和导航等接口，不冒充新版 registry 的组件。主视觉在统一主题和 `beui-overrides.css` 维护。没有复制旧包名的别名，没有修改业务权限和数据库。\n\n验收包含新增组件契约测试和已有全量功能回归、类型检查、Lint、生产构建及运行产物验证。浏览器、真实模型与外部服务未执行时必须另行标注，不能把替身测试称为真实端到端通过。\n');
  console.log(`Migrated ${modified} application/test files; no backend policies or schemas changed.`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
