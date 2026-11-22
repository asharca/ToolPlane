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
if (failed) process.exitCode = 1;
