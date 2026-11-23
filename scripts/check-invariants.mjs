import { readdirSync, readFileSync } from "node:fs";
import ts from "typescript";

const fetchBoundaries = {
  "ConversationComposer.tsx": 1, // Blob preview.
  "ConversationToolOutput.tsx": 1, // Blob download.
  "WorkspaceFilesManager.tsx": 1, // Blob preview.
  "agents/AgentConversation.tsx": 1, // Streaming chat transport.
  "chat/AssistantConversation.tsx": 3, // Stream, reconnect, attachment upload.
  "knowledge/WorkspaceKnowledge.tsx": 1, // Multipart import.
  "sandboxes/SandboxConsole.tsx": 1, // Multipart upload.
  "work/ConversationExportDialog.tsx": 1, // Export download.
  "work/useLiveTaskOutput.ts": 1, // Live event stream.
};
const sessionOnlyAdminRoute = "src/app/api/v1/admin/system/update/route.ts";
let failed = false;

for (const directory of ["src/app/api", "src/components/dashboard"]) {
  const dashboard = directory.endsWith("dashboard");
  for (const file of readdirSync(directory, { recursive: true })) {
    if (!/\.tsx?$/.test(file)) continue;
    const path = `${directory}/${file}`;
    const source = ts.createSourceFile(
      path,
      readFileSync(path, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    let fetchCount = 0;
    const report = (node, message) => {
      const { line } = source.getLineAndCharacterOfPosition(
        node.getStart(source),
      );
      console.error(`${path}:${line + 1}: ${message}`);
      failed = true;
    };
    const visit = (node) => {
      if (
        !dashboard &&
        path !== sessionOnlyAdminRoute &&
        ts.isImportDeclaration(node) &&
        /(?:^|\/)auth\/(?:current-user|session)$/.test(
          node.moduleSpecifier.text,
        )
      )
        report(
          node,
          "Use the shared request principal resolver for session authentication.",
        );
      if (
        dashboard &&
        ts.isCallExpression(node) &&
        node.expression.getText(source) === "fetch"
      ) {
        fetchCount += 1;
        if (
          fetchCount >
          (Object.hasOwn(fetchBoundaries, file) ? fetchBoundaries[file] : 0)
        )
          report(
            node,
            "Use apiRequest for JSON or document the non-JSON transport boundary.",
          );
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
}

// next-intl renders a missing key as its raw path, so check every statically
// known key against both catalogs. Dynamic keys must name an existing group.
const catalogs = ["en", "zh"].map((locale) => ({
  locale,
  messages: JSON.parse(readFileSync(`messages/${locale}.json`, "utf8")),
}));
const translatorFactories = new Set(["useTranslations", "getTranslations"]);
const translatorMethods = new Set(["rich", "markup", "raw"]);
const catalogValue = (messages, path) =>
  path
    .split(".")
    .reduce(
      (value, part) =>
        value && typeof value === "object" && Object.hasOwn(value, part)
          ? value[part]
          : undefined,
      messages,
    );
const translatorNamespace = (initializer) => {
  const call = ts.isAwaitExpression(initializer)
    ? initializer.expression
    : initializer;
  if (
    !ts.isCallExpression(call) ||
    !ts.isIdentifier(call.expression) ||
    !translatorFactories.has(call.expression.text)
  )
    return undefined;
  const [argument] = call.arguments;
  if (!argument) return "";
  if (ts.isStringLiteralLike(argument)) return argument.text;
  if (ts.isObjectLiteralExpression(argument)) {
    const namespace = argument.properties.find(
      (property) =>
        ts.isPropertyAssignment(property) &&
        property.name.getText() === "namespace",
    );
    if (!namespace) return "";
    if (ts.isStringLiteralLike(namespace.initializer))
      return namespace.initializer.text;
  }
  return undefined;
};
for (const file of readdirSync("src", { recursive: true })) {
  if (!/\.tsx?$/.test(file)) continue;
  const path = `src/${file}`;
  const text = readFileSync(path, "utf8");
  if (
    !path.startsWith("src/lib/admin/") &&
    !/^src\/lib\/workspace\/(?:scope|permissions|management)\.ts$/.test(path)
  ) {
    const obsolete =
      /role:\s*\{\s*in:\s*\[\s*"owner",\s*"admin"|capability:\s*"manage"/g;
    for (const match of text.matchAll(obsolete)) {
      const line = text.slice(0, match.index).split("\n").length;
      console.error(
        `${path}:${line}: Use a domain-specific workspace permission.`,
      );
      failed = true;
    }
  }
  if (!/\b(?:useTranslations|getTranslations)\b/.test(text)) continue;
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const scopes = [new Map()];
  const report = (node, message) => {
    const { line } = source.getLineAndCharacterOfPosition(
      node.getStart(source),
    );
    console.error(`${path}:${line + 1}: ${message}`);
    failed = true;
  };
  const namespaceOf = (name) => {
    for (let index = scopes.length - 1; index >= 0; index--)
      if (scopes[index].has(name)) return scopes[index].get(name);
    return undefined;
  };
  const checkKey = (node, namespace, argument) => {
    if (ts.isConditionalExpression(argument)) {
      checkKey(node, namespace, argument.whenTrue);
      checkKey(node, namespace, argument.whenFalse);
      return;
    }
    if (ts.isParenthesizedExpression(argument))
      return checkKey(node, namespace, argument.expression);
    const prefix = namespace ? `${namespace}.` : "";
    if (ts.isStringLiteralLike(argument)) {
      for (const { locale, messages } of catalogs)
        if (typeof catalogValue(messages, prefix + argument.text) !== "string")
          report(node, `Missing ${locale} message ${prefix}${argument.text}.`);
      return;
    }
    if (ts.isTemplateExpression(argument) && argument.head.text.endsWith(".")) {
      const group = prefix + argument.head.text.slice(0, -1);
      for (const { locale, messages } of catalogs) {
        const value = catalogValue(messages, group);
        if (!value || typeof value !== "object")
          report(node, `Missing ${locale} message group ${group}.`);
      }
    }
  };
  const visit = (node) => {
    const scoped = ts.isFunctionLike(node);
    if (scoped) scopes.push(new Map());
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      const namespace = translatorNamespace(node.initializer);
      if (namespace !== undefined)
        scopes[scopes.length - 1].set(node.name.text, namespace);
    }
    if (ts.isCallExpression(node) && node.arguments.length) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee) &&
            ts.isIdentifier(callee.expression) &&
            translatorMethods.has(callee.name.text)
          ? callee.expression.text
          : undefined;
      const namespace = name === undefined ? undefined : namespaceOf(name);
      if (namespace !== undefined) checkKey(node, namespace, node.arguments[0]);
    }
    ts.forEachChild(node, visit);
    if (scoped) scopes.pop();
  };
  visit(source);
}
if (failed) process.exitCode = 1;
