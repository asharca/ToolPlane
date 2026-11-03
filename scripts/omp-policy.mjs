// First trusted extension; OMP rebinds this factory for every native child.
// Plugin code is trusted sandbox code. These ceilings prevent accidental widening,
// not arbitrary-code isolation; every proxy call still checks the live grant.
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { createOmpUi } from "./omp-ui.mjs";
import { loadPinnedPlugin, drainOmpHooks } from "./omp-hooks.mjs";
import {
  preparePinnedSubagentTaskInput,
  prepareNativeSubagentTaskInput,
} from "./omp-capabilities.mjs";

const builtins = new Set([
  "read",
  "bash",
  "edit",
  "ast_grep",
  "ast_edit",
  "ask",
  "debug",
  "ida",
  "eval",
  "github",
  "glob",
  "grep",
  "find",
  "lsp",
  "checkpoint",
  "rewind",
  "context_notes",
  "new_context",
  "security_scan",
  "task",
  "wait",
  "todo",
  "web_search",
  "write",
  "memory_edit",
  "retain",
  "recall",
  "reflect",
  "learn",
  "manage_skill",
]);
// Module state is shared by rebound factories, not saved or replayed across turns.
const reservations = new Map();
const seenSpawns = new Set();
const nativeRoles = new Map();
const nativeModels = new Map();
let lifecycleUnsubscribe;
export default async function toolplanePolicy(pi) {
  const config = JSON.parse(
    readFileSync(process.env.TOOLPLANE_OMP_POLICY, "utf8"),
  );
  const children = new Map(
    (config.subagents ?? []).map((child) => [child.nativeName, child]),
  );
  const mode = config.subagentMode;
  const native = mode === "native";
  const platform = mode === "platform";
  const modern = config.subagents !== undefined || mode !== undefined;
  const pinned = modern && mode === undefined;
  const delegationTools = new Set(config.platformDelegationTools ?? []);
  const pluginToolOwners = new Map();
  const pluginAllowed = (child, installId) =>
    Boolean(
      child?.definition.permissions.pluginInstallIds?.includes(installId) &&
        (
          child.livePluginInstallIds ??
          child.definition.permissions.pluginInstallIds
        ).includes(installId),
    );
  const models = [
    config.modelSelector,
    ...[...children.values()].map((child) => child.modelSelector),
    ...(config.nativeRoleModels ?? []).map((role) => role.modelSelector),
  ];
  const disabled = new Set(config.disabledTools);
  for (const name of builtins)
    if (!config.tools.includes(name)) disabled.add(name);
  const overrides = {
    enabledModels: [...new Set(models)],
    enabledProviders: [],
    disabledProviders: [
      "claude",
      "claude-plugins",
      "codex",
      "gemini",
      "github",
      "opencode",
      "cursor",
      "windsurf",
      "agents-md",
      "omp-plugins",
    ],
    modelRoles: Object.fromEntries(
      [
        "default",
        "smol",
        "slow",
        "plan",
        "advisor",
        "vision",
        "tiny",
        "memory",
      ].map((role) => [role, config.modelSelector]),
    ),
    modelPresets: {},
    modelProviderOrder: [
      ...new Set(models.map((model) => model.split("/")[0])),
    ],
    ...(modern
      ? {
          "task.maxConcurrency": config.policy.maxConcurrency,
          "task.maxRecursionDepth": config.policy.maxDepth,
          "task.prewalk": false,
          "task.disabledAgents": native
            ? []
            : [
                "scout",
                "reviewer",
                "security-reviewer",
                "seance",
                "task",
                "sonic",
              ],
        }
      : {}),
    "providers.cacheWarming": "off",
    "tools.xdev": false,
    "mcp.enableProjectConfig": false,
    // Speculative task execution must not bypass the published spawn gate.
    "task.speculativeLaunch": false,
    "retry.fallbackChains": {},
    "task.agentModelOverrides": {},
    ...(mode
      ? {
          "task.agentPrewalk": {},
          "task.agentAdvisor": {},
          "task.agentAccountPools": {},
          "advisor.enabled": false,
        }
      : {}),
  };
  for (const [id, value] of Object.entries(overrides)) {
    const setting = lookup(id);
    if (!setting) throw new Error("OMP_POLICY_SETTING_UNAVAILABLE");
    setting.override(pi.pi.settings, value);
  }
  const definitionFor = (ctx) =>
    ctx.agent?.kind === "sub" ? children.get(ctx.agent.name) : undefined;
  const sourceFor = (ctx) => ({
    subagentId: ctx.agent.id,
    subagentVersionId: definitionFor(ctx)?.versionId,
    subagentName:
      definitionFor(ctx)?.name ??
      nativeRoles.get(ctx.agent.name) ??
      ctx.agent.name,
    depth: ctx.agent.depth,
  });
  const permitted = (name, ctx) => {
    if (platform && ["task", "wait"].includes(name)) return false;
    if (
      native &&
      ctx.agent?.kind === "sub" &&
      (delegationTools.has(name) || name === "todo")
    )
      return false;
    if (disabled.has(name)) return false;
    if (ctx.agent?.kind !== "sub" || !pinned) return true;
    const child = definitionFor(ctx);
    const owner = pluginToolOwners.get(name);
    return Boolean(
      child?.tools.includes(name) && (!owner || pluginAllowed(child, owner)),
    );
  };
  async function authorize(child, signal) {
    const response = await fetch(
      `${config.authorizeBase}/${encodeURIComponent(child.subagentId)}/authorize`,
      {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: `Bearer ${process.env.TOOLPLANE_RUNTIME_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ versionId: child.versionId }),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
          : AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("OMP_SUBAGENT_REVOKED");
    }
    const result = await response.json();
    if (result.allowed !== true) throw new Error("OMP_SUBAGENT_REVOKED");
    const permissions = result.permissions;
    if (
      !permissions ||
      !Array.isArray(permissions.builtinTools) ||
      !Array.isArray(permissions.mcpTools) ||
      !Array.isArray(permissions.skillIds) ||
      !Array.isArray(permissions.pluginInstallIds ?? [])
    )
      throw new Error("OMP_SUBAGENT_REVOKED");
    child.livePluginInstallIds = (
      child.definition.permissions.pluginInstallIds ?? []
    ).filter((id) => (permissions.pluginInstallIds ?? []).includes(id));
    child.tools = child.tools.filter((name) => {
      const owner = pluginToolOwners.get(name);
      if (owner) return pluginAllowed(child, owner);
      if (permissions.builtinTools.includes(name)) return true;
      const origin = config.hostToolOrigins?.[name];
      return (
        origin &&
        permissions.mcpTools.some(
          (grant) =>
            grant.deploymentId === origin.deploymentId &&
            grant.tools.includes(origin.toolName),
        )
      );
    });
    child.liveSkillIds = child.definition.permissions.skillIds.filter((id) =>
      permissions.skillIds.includes(id),
    );
  }
  pi.on("before_subagent_spawn", async (event, ctx) => {
    if (platform)
      return {
        block: true,
        reason: "Native delegation is disabled in platform mode",
      };
    if (native) {
      if (event.invocationKind !== "task")
        return {
          block: true,
          reason:
            "Use the native task tool (including eval tool.task) so role and tool ceilings are checked",
        };
      const key = event.spawnKey && `${ctx.agent.id}:${event.spawnKey}`;
      if (
        !nativeRoles.has(event.agent) ||
        !key ||
        (ctx.agent?.depth ?? 0) + 1 > config.policy.maxDepth
      )
        return {
          block: true,
          reason:
            "Only task-generated roles within the frozen native depth are permitted",
        };
      if (
        seenSpawns.has(key) ||
        seenSpawns.size >= 4096 ||
        reservations.size >= config.policy.maxConcurrency
      )
        return {
          block: true,
          reason: "Native task concurrency or invocation limit reached",
        };
      reservations.set(key, { nativeName: event.agent, nativeId: undefined });
      seenSpawns.add(key);
      return { model: nativeModels.get(event.agent) };
    }
    if (!modern) return { model: config.modelSelector };
    const child = children.get(event.agent);
    const parent = definitionFor(ctx);
    const depth = (ctx.agent?.depth ?? 0) + 1;
    if (
      !child ||
      (ctx.agent?.kind === "sub" &&
        (!parent?.definition.allowNested ||
          depth > parent.definition.maxDepth)) ||
      depth > config.policy.maxDepth ||
      depth > child.definition.maxDepth
    )
      return {
        block: true,
        reason: "Subagent is outside the pinned delegation policy",
      };
    try {
      await authorize(child, ctx.signal);
      const key = event.spawnKey && `${ctx.agent.id}:${event.spawnKey}`;
      if (!key)
        return { block: true, reason: "Native spawn identity is required" };
      const active = [...reservations.values()];
      if (seenSpawns.has(key) || seenSpawns.size >= 4096)
        return {
          block: true,
          reason: "Subagent invocation was already authorized; do not replay",
        };
      if (
        active.length >= config.policy.maxConcurrency ||
        active.filter((value) => value.versionId === child.versionId).length >=
          child.definition.maxConcurrency
      )
        return {
          block: true,
          reason: "Pinned subagent concurrency limit reached",
        };
      reservations.set(key, {
        versionId: child.versionId,
        nativeName: child.nativeName,
        nativeId: undefined,
      });
      seenSpawns.add(key);
      return { model: child.modelSelector };
    } catch {
      return { block: true, reason: "Pinned subagent authorization failed" };
    }
  });
  // Sync task spawns may use call-id:index as the gate key before native id allocation.
  // Bind that reservation to the actual lifecycle identity exactly once.
  if (!lifecycleUnsubscribe)
    lifecycleUnsubscribe = pi.events.on(
      "task:subagent:lifecycle",
      (payload) => {
        const entries = [...reservations.entries()];
        const entry =
          entries.find(([, value]) => value.nativeId === payload.id) ??
          entries.find(
            ([, value]) =>
              !value.nativeId && value.nativeName === payload.agent,
          );
        if (!entry) return;
        if (payload.status === "started") entry[1].nativeId = payload.id;
        else if (["completed", "failed", "aborted"].includes(payload.status))
          reservations.delete(entry[0]);
      },
    );
  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.agent?.kind === "main") {
      lifecycleUnsubscribe?.();
      lifecycleUnsubscribe = undefined;
    }
    for (const [key, value] of reservations)
      if (value.nativeId === ctx.agent?.id || ctx.agent?.kind === "main")
        reservations.delete(key);
  });
  pi.on("tool_call", async (event, ctx) => {
    if (pinned && ctx.agent?.kind === "sub") {
      try {
        const child = definitionFor(ctx);
        if (!child) throw new Error();
        await authorize(child, ctx.signal);
      } catch {
        return {
          block: true,
          reason: "Pinned subagent authorization was revoked",
        };
      }
    }
    if (!permitted(event.toolName, ctx))
      return {
        block: true,
        reason: "Tool disabled by the published ToolPlane revision",
      };
    if (
      (event.toolName === "read" || event.toolName === "write") &&
      typeof event.input?.path === "string" &&
      event.input.path.startsWith("xd://")
    ) {
      const inner = event.input.path.slice(5).split(/[/?#]/)[0];
      if (!permitted(inner, ctx))
        return {
          block: true,
          reason: "Tool disabled by the published ToolPlane revision",
        };
    }
    if (
      pinned &&
      ctx.agent?.kind === "sub" &&
      event.toolName === "read" &&
      typeof event.input?.path === "string"
    ) {
      const path = event.input.path;
      const child = definitionFor(ctx);
      if (
        path.startsWith("skill://") ||
        path.includes("/agent/skills/") ||
        /\/\.toolplane\/runtimes\/omp\/agents\/[^/]+\/revisions\/[^/]+\/skills(?:\/|$)/.test(
          path,
        )
      ) {
        const name = path.slice("skill://".length).split(/[/?#]/)[0];
        const matches = config.skillIdentities.filter((skill) =>
          path.startsWith("skill://")
            ? [skill.name, skill.directory].includes(name)
            : path === skill.path || path.startsWith(`${skill.path}/`),
        );
        if (
          !matches.length ||
          matches.some(
            (skill) =>
              !skill.installedSkillId ||
              !child.liveSkillIds?.includes(skill.installedSkillId),
          )
        )
          return {
            block: true,
            reason: "Skill is outside the pinned subagent grant",
          };
      }
    }
    if (native && event.toolName === "task") {
      try {
        return {
          input: await prepareNativeSubagentTaskInput(event.input, {
            agentDir: config.agentDir,
            modelSelector:
              nativeModels.get(ctx.agent?.name) ?? config.modelSelector,
            tools: pi
              .getActiveTools()
              .filter(
                (name) => permitted(name, ctx) && !delegationTools.has(name),
              ),
            register: (name, role, model) => {
              if (!models.includes(model))
                throw new Error("OMP_NATIVE_MODEL_OVERRIDE_FORBIDDEN");
              nativeRoles.set(name, role);
              nativeModels.set(name, model);
            },
          }),
        };
      } catch (error) {
        return {
          block: true,
          reason:
            error.message === "OMP_NATIVE_TASK_OVERRIDE_FORBIDDEN"
              ? "Native tasks use frozen role models and inherited tools; model overrides, eval-defined tools and source sessions are forbidden"
              : "Native tasks require an inline assignment and a temporary role name",
        };
      }
    }
    if (pinned && event.toolName === "task") {
      try {
        return {
          input: preparePinnedSubagentTaskInput(
            event.input,
            children,
            () => ctx.sessionManager.getBranch?.() ?? [],
          ),
        };
      } catch (error) {
        const reasons = {
          OMP_SUBAGENT_UNAVAILABLE:
            "Use an exact configured subagent call name in tasks[].agent.",
          OMP_SUBAGENT_PARENT_TOOLS_FORBIDDEN:
            "Parent eval-defined tools are not granted to pinned subagents.",
          OMP_SUBAGENT_CONTEXT_LIMIT:
            "Inherited subagent context exceeds the size limit.",
        };
        return {
          block: true,
          reason:
            reasons[error.message] ??
            "Pinned subagent context could not be assembled",
        };
      }
    }
  });
  pi.on("before_agent_start", async (_event, ctx) => {
    if (
      native &&
      ctx.agent?.kind === "sub" &&
      !nativeRoles.has(ctx.agent.name)
    ) {
      ctx.abort();
      throw new Error("OMP_NATIVE_ROLE_UNAUTHORIZED");
    }
    if (native && ctx.agent?.kind === "sub") {
      const directory = join(config.agentDir, "native-sources");
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      writeFileSync(
        join(directory, `${encodeURIComponent(ctx.agent.id)}.json`),
        JSON.stringify(sourceFor(ctx)),
        { mode: 0o600 },
      );
    }
    const current = pi.getActiveTools();
    const allowed = current.filter((name) => permitted(name, ctx));
    if (allowed.length !== current.length) await pi.setActiveTools(allowed);
    if (ctx.agent?.kind === "sub" && pinned) {
      const child = definitionFor(ctx);
      try {
        if (!child) throw new Error();
        await authorize(child, ctx.signal);
      } catch {
        ctx.abort();
        throw new Error("OMP_SUBAGENT_REVOKED");
      }
    }
    if (ctx.agent?.kind !== "sub") {
      const hostTools = (config.hostTools ?? []).filter(({ name }) =>
        allowed.includes(name),
      );
      if (hostTools.length)
        return {
          systemPrompt: [
            ..._event.systemPrompt,
            "Host MCP tools: labels in platform instructions identify original MCP operations, not callable runtime names. Use the exact callName below for direct tool calls. In JavaScript eval, invoke await tool[callName](parameters) (for example, use the listed callName for pi_a2a_peers, not tool.pi_a2a_peers). Await the result; do not switch languages or guess aliases when a label is unknown. These runtime IDs are generated internal adapters, not user configuration. Native children retain only their own authorized tools.",
            JSON.stringify(
              hostTools.map(({ label, name }) => ({ label, callName: name })),
            ),
          ],
        };
    }
  });
  let requests = 0;
  pi.on("before_provider_request", async (_event, ctx) => {
    const expectedModel =
      ctx.agent?.kind === "sub"
        ? nativeModels.get(ctx.agent.name)
        : config.modelSelector;
    if (
      native &&
      (!expectedModel ||
        `${ctx.model?.provider}/${ctx.model?.id}` !== expectedModel)
    ) {
      ctx.abort();
      throw new Error("OMP_NATIVE_MODEL_OVERRIDE_FORBIDDEN");
    }
    if (ctx.agent?.kind !== "sub") {
      // Reserved host projection, carried by the ordered native RPC stream.
      ctx.ui.setStatus("toolplane.executionStage", "waiting-model");
      return;
    }
    if (!pinned) return;
    const child = definitionFor(ctx);
    try {
      if (!child || ++requests > child.definition.maxSteps)
        throw new Error("OMP_SUBAGENT_STEP_LIMIT");
      await authorize(child, ctx.signal);
    } catch {
      ctx.abort();
      throw new Error("OMP_SUBAGENT_REVOKED");
    }
  });
  if (modern && config.uiUrl) {
    const t = pi.typebox.Type;
    pi.registerTool({
      name: "ask",
      label: "Ask user",
      description:
        "Ask the user questions and wait for their actual response. No answer is chosen automatically.",
      approval: "read",
      parameters: t.Object({
        questions: t.Array(
          t.Object({
            id: t.String(),
            question: t.String(),
            options: t.Array(
              t.Object({
                label: t.String(),
                description: t.Optional(t.String()),
              }),
            ),
            multi: t.Optional(t.Boolean()),
            recommended: t.Optional(t.Integer({ minimum: 0 })),
          }),
          { minItems: 1, maxItems: 64 },
        ),
      }),
      async execute(_id, params, signal, onUpdate, ctx) {
        if (!permitted("ask", ctx))
          throw new Error("OMP_SUBAGENT_TOOL_FORBIDDEN");
        if (ctx.agent.kind !== "sub") {
          if (!ctx.invokeTool) throw new Error("OMP_NATIVE_ASK_UNAVAILABLE");
          return ctx.invokeTool(params, { signal, onUpdate });
        }
        const child = definitionFor(ctx);
        if (pinned) await authorize(child, signal);
        const id = `child:${ctx.agent.id}:${randomUUID()}`;
        let response;
        const ui = createOmpUi({
          url: config.uiUrl,
          token: process.env.TOOLPLANE_RUNTIME_TOKEN,
          send: (value) => {
            response = value;
          },
          onError: () => ctx.abort(),
        });
        const cancel = () => {
          void ui.close();
        };
        signal?.addEventListener("abort", cancel, { once: true });
        try {
          if (signal?.aborted) throw new Error("OMP_ABORTED");
          await ui.request({
            type: "extension_ui_request",
            id,
            method: "ask",
            title:
              child?.name ?? nativeRoles.get(ctx.agent.name) ?? ctx.agent.name,
            questions: params.questions,
            source: sourceFor(ctx),
          });
          if (!response || response.cancelled || signal?.aborted) {
            ctx.abort();
            throw new Error("OMP_ASK_CANCELLED");
          }
          return {
            content: [
              {
                type: "text",
                text: `User answers:\n${JSON.stringify(response.answers)}`,
              },
            ],
            details: { results: response.answers, source: sourceFor(ctx) },
          };
        } finally {
          signal?.removeEventListener("abort", cancel);
          await ui.close();
        }
      },
    });
  }
  for (const plugin of config.plugins ?? [])
    await loadPinnedPlugin(pi, plugin, {
      uiUrl: config.uiUrl,
      cwd: config.cwd,
      subagents: [...children.values()],
      inheritParentPermissions: native,
      authorizePlugin: async (ctx, installId) => {
        if (native)
          return (config.plugins ?? []).some(
            (plugin) => plugin.installId === installId,
          );
        const child = definitionFor(ctx);
        if (!child) return false;
        await authorize(child, ctx.signal);
        return pluginAllowed(child, installId);
      },
      onToolRegistered: (name) => {
        const owner = pluginToolOwners.get(name);
        if (owner && owner !== plugin.installId)
          throw new Error("OMP_PLUGIN_TOOL_CONFLICT");
        pluginToolOwners.set(name, plugin.installId);
        for (const child of children.values()) {
          if (
            pluginAllowed(child, plugin.installId) &&
            !child.tools.includes(name)
          )
            child.tools.push(name);
        }
      },
    });
  // Native message notifications can outlive their display frame. The terminal
  // extension pass is awaited by OMP before prompt settlement.
  pi.on("agent_end", () => drainOmpHooks());
  pi.on("session_shutdown", () => drainOmpHooks());
}
