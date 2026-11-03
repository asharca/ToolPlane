import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";

export function officialTodoPath(sdkEntry) {
  return realpathSync(
    join(dirname(sdkEntry), "../examples/extensions/todo.ts"),
  );
}

// This is a read-only projection of the installed official example's state
// reconstruction. SessionManager's current branch is the only source of truth.
export function nativeTodos(sessionManager) {
  const entry = sessionManager
    .getBranch()
    .findLast(
      (entry) =>
        entry.type === "message" &&
        entry.message.role === "toolResult" &&
        entry.message.toolName === "todo",
    );
  const candidate = entry?.message.details?.todos;
  // Third-party todo tools remain native, but their unrelated details schemas
  // are not an invitation to invent a conversion or reject tool execution.
  return Array.isArray(candidate) &&
    candidate.every(
      (todo) =>
        todo !== null &&
        typeof todo === "object" &&
        typeof todo.id === "number" &&
        Number.isInteger(todo.id) &&
        typeof todo.text === "string" &&
        typeof todo.done === "boolean",
    )
    ? candidate.map(({ id, text, done }) => ({ id, text, done }))
    : [];
}

export function configureNativeTodo(base, path) {
  const official = base.extensions.find(
    (extension) => extension.resolvedPath === path,
  );
  const packageTodo = base.extensions.find(
    (extension) =>
      extension.resolvedPath !== path && extension.tools.has("todo"),
  );
  if (packageTodo) {
    base.extensions = base.extensions.filter(
      (extension) => extension.resolvedPath !== path,
    );
    // DefaultResourceLoader diagnoses collisions before extensionsOverride. Its
    // diagnostic for this deliberately removed fallback is no longer applicable;
    // retain every package collision and all actual module-loading errors.
    if (official)
      base.errors = base.errors.filter(
        (issue) =>
          issue.path !== official.path ||
          issue.error !== `Tool "todo" conflicts with ${packageTodo.path}`,
      );
    return base;
  }
  const command = official?.commands.get("todos");
  if (command) {
    const interactiveHandler = command.handler;
    command.handler = async (args, ctx) => {
      if (ctx.mode !== "rpc") return interactiveHandler(args, ctx);
      const todos = nativeTodos(ctx.sessionManager);
      ctx.ui.notify(
        todos.length
          ? todos
              .map(
                (todo) =>
                  `[${todo.done ? "x" : " "}] #${todo.id}: ${todo.text}`,
              )
              .join("\n")
          : "No todos",
        "info",
      );
    };
  }
  return base;
}
