import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { createOmpUi } from "./omp-ui.mjs";

class OmpDeadlineError extends Error {}

/** @typedef {{id: string, event: string, status: "completed" | "failed" | "timed_out", durationMs: number, result?: "blocked" | "cancelled" | "modified" | "unchanged"}} HookExecution */

const pendingHooks = new Set();

export async function drainOmpHooks() {
  while (pendingHooks.size) {
    try {
      await bounded(
        Promise.allSettled([...pendingHooks]),
        30_000,
        "OMP_HOOK_DRAIN_TIMEOUT",
      );
    } catch {
      break;
    }
  }
}

async function bounded(operation, timeoutMs, code) {
  const timeout = Promise.withResolvers();
  const timer = setTimeout(
    () => timeout.reject(new OmpDeadlineError(code)),
    timeoutMs,
  );
  try {
    return await Promise.race([operation, timeout.promise]);
  } finally {
    clearTimeout(timer);
  }
}

// Hook factories share OMP's extension API subset. Each handler is invoked once;
// timeouts poison the module for the remainder of this process, never replay it.
/**
 * @param {*} pi OMP's dynamically supplied extension API.
 * @param {{timeoutMs?: number, onFailure?: (failure: {event: string, code: string}) => void, mapContext?: (ctx: any) => any, canExecute?: (ctx: any) => boolean | Promise<boolean>, onInvocation?: (record: HookExecution, ctx: any) => void | Promise<void>, onToolRegistered?: (name: string) => void}} [options={}]
 */
export function guardedHookApi(
  pi,
  {
    timeoutMs = 10_000,
    onFailure = () => {},
    mapContext = (value) => value,
    canExecute = () => true,
    onInvocation = () => {},
    onToolRegistered = () => {},
  } = {},
) {
  let poisoned = false;
  const registered = new Set();
  const controls = new Set(["tool_call", "before_subagent_spawn"]);
  const cancellable = new Set([
    "session_before_switch",
    "session_before_branch",
    "session_before_compact",
    "session_before_tree",
    "session.compacting",
  ]);
  const failure = (event, ctx) => {
    if (controls.has(event))
      return {
        block: true,
        reason:
          "Pinned plugin hook failed; execution denied. Do not replay side effects.",
      };
    if (cancellable.has(event)) return { cancel: true };
    if (event === "session_stop") {
      ctx?.abort?.();
      return {
        decision: "block",
        reason:
          "Pinned plugin hook failed; execution denied. Do not replay side effects.",
      };
    }
    if (
      ["before_agent_start", "before_provider_request", "context"].includes(
        event,
      )
    )
      ctx?.abort?.();
    return undefined;
  };
  return new Proxy(pi, {
    get(target, key) {
      if (key === "registerTool")
        return (tool) => {
          onToolRegistered(tool.name);
          return target.registerTool({
            ...tool,
            async execute(...args) {
              if (!(await canExecute(args[4])))
                throw new Error("OMP_PLUGIN_SCOPE_DENIED");
              return tool.execute(...args);
            },
          });
        };
      if (key !== "on") return Reflect.get(target, key, target);
      return (event, handler) => {
        if (typeof handler !== "function" || registered.size >= 256)
          throw new Error("OMP_HOOK_INVALID");
        registered.add(handler);
        target.on(event, (payload, ctx) => {
          const pending = (async () => {
            try {
              if (!(await canExecute(ctx))) return undefined;
            } catch {
              return failure(event, ctx);
            }
            if (poisoned) return failure(event, ctx);
            ctx = mapContext(ctx);
            const started = performance.now();
            /** @type {HookExecution} */
            const record = {
              id: randomUUID(),
              event,
              status: "completed",
              durationMs: 0,
            };
            try {
              const result = await bounded(
                Promise.resolve().then(() => handler(payload, ctx)),
                timeoutMs,
                "OMP_HOOK_TIMEOUT",
              );
              record.result =
                result?.block === true || result?.decision === "block"
                  ? "blocked"
                  : result?.cancel === true
                    ? "cancelled"
                    : result === undefined
                      ? "unchanged"
                      : "modified";
              return result;
            } catch (error) {
              record.status =
                error instanceof OmpDeadlineError ? "timed_out" : "failed";
              poisoned = true;
              try {
                onFailure({
                  event,
                  code:
                    record.status === "timed_out"
                      ? "OMP_HOOK_TIMEOUT"
                      : "OMP_HOOK_FAILED",
                });
                ctx?.ui?.notify?.(
                  "Pinned plugin hook failed; automatic replay is disabled.",
                  "error",
                );
              } catch {
                /* Diagnostics never turn a blocking failure into permission. */
              }
              return failure(event, ctx);
            } finally {
              record.durationMs = Math.max(
                0,
                Math.round(performance.now() - started),
              );
              try {
                await bounded(
                  Promise.resolve().then(() => onInvocation(record, ctx)),
                  timeoutMs,
                  "OMP_HOOK_RECORD_TIMEOUT",
                );
              } catch {
                try {
                  onFailure({ event, code: "OMP_HOOK_RECORD_FAILED" });
                } catch {
                  /* Reporting cannot change the handler's result. */
                }
              }
            }
          })();
          pendingHooks.add(pending);
          void pending.then(
            () => pendingHooks.delete(pending),
            () => pendingHooks.delete(pending),
          );
          return pending;
        });
      };
    },
  });
}

/**
 * @param {*} pi OMP's dynamically supplied extension API.
 * @param {{installId: string, name: string, resources: Partial<Record<"hooks" | "extensions" | "tools" | "commands", string[]>>}} plugin Resolved immutable executable entry paths and stable install identity.
 * @param {{uiUrl?: string, cwd?: string, inheritParentPermissions?: boolean, subagents?: Array<{nativeName: string, name: string, versionId: string, definition?: {permissions: {pluginInstallIds?: string[]}}}>, authorizePlugin?: (ctx: any, installId: string) => Promise<boolean>, onToolRegistered?: (name: string) => void}} [options={}] Platform UI, factory directory, child snapshots, and live scope authorization.
 */
export async function loadPinnedPlugin(
  pi,
  plugin,
  {
    uiUrl,
    cwd,
    subagents = [],
    authorizePlugin,
    inheritParentPermissions = false,
    onToolRegistered = () => {},
  } = {},
) {
  const seen = new Set();
  if (!plugin.installId || !plugin.name)
    throw new Error("OMP_PLUGIN_IDENTITY_INVALID");
  const canExecute = async (ctx) => {
    if (ctx?.agent?.kind !== "sub") return true;
    if (inheritParentPermissions)
      return authorizePlugin ? authorizePlugin(ctx, plugin.installId) : false;
    const child = subagents.find(
      (child) => child.nativeName === ctx.agent.name,
    );
    if (
      !child?.definition?.permissions.pluginInstallIds?.includes(
        plugin.installId,
      )
    )
      return false;
    return authorizePlugin ? authorizePlugin(ctx, plugin.installId) : false;
  };
  const reportFailure = () =>
    pi.logger?.warn?.("OMP_PLUGIN_NOTIFICATION_FAILED");
  const ui = createOmpUi({
    url: uiUrl,
    token: process.env.TOOLPLANE_RUNTIME_TOKEN,
    send: () => {},
    onError: reportFailure,
  });
  pi.on("session_shutdown", () => ui.close());
  const sourceFor = (ctx) => {
    if (ctx.agent?.kind !== "sub") return undefined;
    const child = subagents.find(
      (child) => child.nativeName === ctx.agent.name,
    );
    return {
      subagentId: ctx.agent.id,
      subagentName: child?.name ?? ctx.agent.name,
      ...(child ? { subagentVersionId: child.versionId } : {}),
      depth: ctx.agent.depth,
    };
  };
  const mapContext = (ctx) => {
    const source = sourceFor(ctx);
    if (!source) return ctx;
    return new Proxy(ctx, {
      get(target, key) {
        if (key !== "ui") return Reflect.get(target, key, target);
        return new Proxy(target.ui, {
          get(target, key) {
            if (key !== "notify") return Reflect.get(target, key, target);
            return (message, notifyType = "info") => {
              void ui
                .request({
                  type: "extension_ui_request",
                  id: `child-notify:${randomUUID()}`,
                  method: "notify",
                  message,
                  notifyType,
                  source,
                })
                .catch(reportFailure);
            };
          },
        });
      },
    });
  };
  for (const kind of ["hooks", "extensions"]) {
    for (const path of plugin.resources[kind] ?? []) {
      if (seen.has(path)) continue;
      seen.add(path);
      const module = await import(pathToFileURL(path).href);
      const factory =
        typeof module.default === "function"
          ? module.default
          : module.default?.default;
      if (typeof factory !== "function")
        throw new Error("OMP_PLUGIN_ENTRY_INVALID");
      // Bound registration too; a rejected startup is never retried in this run.
      await bounded(
        Promise.resolve().then(() =>
          factory(
            guardedHookApi(pi, {
              mapContext,
              canExecute,
              onToolRegistered,
              onInvocation: (record, ctx) => {
                const source = sourceFor(ctx);
                return ui.hook({
                  ...record,
                  pluginInstallId: plugin.installId,
                  pluginName: plugin.name,
                  ...(source ? { source } : {}),
                });
              },
              onFailure: (failure) => pi.logger?.warn?.(failure.code),
            }),
          ),
        ),
        10_000,
        "OMP_PLUGIN_LOAD_TIMEOUT",
      );
    }
  }
  for (const path of plugin.resources.tools ?? []) {
    if (seen.has(path)) continue;
    seen.add(path);
    const module = await import(pathToFileURL(path).href);
    const factory =
      typeof module.default === "function"
        ? module.default
        : module.default?.default;
    if (typeof factory !== "function")
      throw new Error("OMP_PLUGIN_ENTRY_INVALID");
    const tools = await bounded(
      Promise.resolve().then(() =>
        factory({
          cwd,
          exec: pi.exec,
          logger: pi.logger,
          typebox: pi.typebox,
          arktype: pi.arktype,
          zod: pi.zod,
          pi: pi.pi,
          hasUI: false,
        }),
      ),
      10_000,
      "OMP_PLUGIN_LOAD_TIMEOUT",
    );
    for (const tool of Array.isArray(tools) ? tools : [tools]) {
      if (
        !tool ||
        typeof tool.name !== "string" ||
        typeof tool.execute !== "function"
      )
        throw new Error("OMP_PLUGIN_TOOL_INVALID");
      onToolRegistered(tool.name);
      pi.registerTool({
        ...tool,
        label: tool.label ?? tool.name,
        execute: async (id, params, signal, onUpdate, ctx) => {
          if (!(await canExecute(ctx)))
            throw new Error("OMP_PLUGIN_SCOPE_DENIED");
          return tool.execute(id, params, onUpdate, mapContext(ctx), signal);
        },
      });
    }
  }
}
