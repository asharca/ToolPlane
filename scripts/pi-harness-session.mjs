import { copyFile, lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import {
  AgentHarness,
  BACKGROUND_CONTEXT,
  withAbortSignal,
  branchTip,
  setValue,
  value,
  operationMeta,
  formatSkillsForSystemPrompt,
} from "@earendil-works/pi-agent-core";
import {
  SqliteSessionRepo,
  createNodeSqliteFactory,
} from "@earendil-works/pi-session-backend-sqlite-node";
import {
  ModelRuntime,
  createCodingTools,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { TaskState } from "@a2a-js/sdk";
import {
  approvalReady,
  approveNativeTool,
  freezeArguments,
} from "./a2a-native-approval.mjs";

const migration = value("toolplane", "legacy-import");
const controller = new AbortController();
const context = withAbortSignal(controller.signal, BACKGROUND_CONTEXT);
const stop = () => controller.abort(new Error("PI_DRIVER_INTERRUPTED"));
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
let secret = "";
const emit = (event) => {
  let line = JSON.stringify(event);
  if (secret) line = line.replaceAll(secret, "[redacted]");
  process.stdout.write(`${line}\n`);
};
const failure = (code, message) => Object.assign(new Error(message), { code });
const unwrap = (result) => {
  if (!result.ok) throw result.error;
  return result.value;
};
const textOf = (content) =>
  typeof content === "string"
    ? content
    : (content ?? [])
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function legacyMessages(input) {
  const path = input.legacyStatePath && `${input.legacyStatePath}.jsonl`;
  if (!path || !(await exists(path))) {
    if (input.historyRequired)
      throw failure(
        "PI_SESSION_MISSING",
        "Required legacy session history is missing.",
      );
    return { messages: [], source: "empty" };
  }
  let temporary;
  try {
    // SessionManager migrates older JSONL in place. Open a copy, never the evidence.
    const records = (await readFile(path, "utf8"))
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
    if (records[0]?.type !== "session" || typeof records[0].id !== "string")
      throw new Error("Invalid legacy session header");
    temporary = await mkdtemp(join(tmpdir(), "toolplane-pi-history-"));
    const copy = join(temporary, "session.jsonl");
    await copyFile(path, copy);
    const messages = SessionManager.open(copy).buildSessionContext().messages;
    if (
      !Array.isArray(messages) ||
      messages.some(
        (message) =>
          !message ||
          typeof message.role !== "string" ||
          message.stopReason === "pending",
      )
    )
      throw new Error("Invalid legacy transcript");
    return { messages, source: "legacy" };
  } catch {
    throw failure(
      "PI_SESSION_CORRUPT",
      "Legacy session history is invalid; the original file was preserved.",
    );
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}

async function importHistory(session, input, history) {
  const marker = await session.getValue(migration, context);
  if (marker) {
    if (marker.value?.version !== 1)
      throw failure(
        "PI_SESSION_CORRUPT",
        "Unsupported native history migration marker.",
      );
    return;
  }
  const existing = await session.findEntries({ limit: 1 }, context);
  if (existing.length)
    throw failure(
      "PI_SESSION_CORRUPT",
      "Native session has history without its migration marker.",
    );
  const imported = history ?? (await legacyMessages(input));
  await session.mutate(async (mutation, mutationContext) => {
    const writes = [];
    let parentId = null;
    for (const message of imported.messages) {
      const id = session.idGenerator.next();
      writes.push({
        kind: "entry",
        entry: { type: "message", id, parentId, message },
      });
      parentId = id;
    }
    writes.push(
      setValue(branchTip("main"), parentId),
      setValue(migration, {
        version: 1,
        source: imported.source,
        messageCount: imported.messages.length,
      }),
    );
    await mutation.commit(writes, mutationContext);
  }, context);
}

async function openSession(repository, input) {
  const encoded = /^[A-Za-z0-9_-]+$/.test(input.contextId)
    ? input.contextId
    : `~${Buffer.from(input.contextId, "utf16le").toString("base64url")}`;
  const path = join(input.directory, `${encoded}.sqlite`);
  const present = await exists(path);
  if (
    !present &&
    (input.action !== "prepare" || input.operationId || input.sessionRequired)
  )
    throw failure(
      "PI_SESSION_MISSING",
      "The bound native session database is missing.",
    );
  let session;
  try {
    if (present) {
      // list() deliberately skips corrupt databases; file presence must be checked separately.
      const metadata = (await repository.list(undefined, context)).find(
        (item) => item.id === input.contextId,
      );
      if (!metadata)
        throw failure(
          "PI_SESSION_CORRUPT",
          "Native session metadata is unreadable or incompatible.",
        );
      session = await repository.open(metadata, context);
      await importHistory(session, input);
    } else {
      if ((await exists(`${path}-wal`)) || (await exists(`${path}-shm`)))
        throw failure(
          "PI_SESSION_CORRUPT",
          "Native session database is missing but its journal remains.",
        );
      const history = await legacyMessages(input);
      session = await repository.create({ id: input.contextId }, context);
      await importHistory(session, input, history);
    }
    return session;
  } catch (error) {
    if (controller.signal.aborted || error.code?.startsWith("PI_")) throw error;
    throw failure(
      "PI_SESSION_CORRUPT",
      "Native session storage could not be opened or committed; existing files were preserved.",
    );
  }
}

function prompt(input) {
  const current = input.messages?.at(-1);
  const text = textOf(current?.parts);
  if (current?.role !== "user" || !text.trim())
    throw failure(
      "PI_INPUT_INVALID",
      "A current user message is required for a new native operation.",
    );
  return text;
}

function toolResult(result) {
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    details: {},
  };
}

function communicationTools(client) {
  const invoke = async (name, args, signal) => {
    const result = await client.callTool({ name, arguments: args }, undefined, {
      signal,
    });
    if (result.isError)
      throw new Error(textOf(result.content) || "Agent communication failed.");
    const data = result.structuredContent ?? JSON.parse(textOf(result.content));
    if (!data || typeof data !== "object")
      throw new Error("Invalid agent communication response.");
    return data;
  };
  const stateOf = (result) => {
    const state =
      result.task?.status?.state ?? result.status?.state ?? result.state;
    const name = typeof state === "number" ? TaskState[state] : state;
    if (typeof name !== "string")
      throw new Error("Agent response has no task state.");
    return name
      .replace(/^TASK_STATE_/, "")
      .replaceAll("-", "_")
      .toUpperCase();
  };
  const schema = (properties) => ({
    type: "object",
    properties: Object.fromEntries(
      properties.map((name) => [name, { type: "string", minLength: 1 }]),
    ),
    required: properties,
    additionalProperties: false,
  });
  const tools = [
    [
      "a2a_peers",
      "List explicitly authorized internal and registered external agents.",
      [],
      "pi_a2a_peers",
    ],
    [
      "a2a_status",
      "Read the status and output of your agent delegation.",
      ["target", "taskId"],
      "pi_a2a_status",
    ],
    [
      "a2a_cancel",
      "Request cancellation; only a confirmed terminal state means the child stopped.",
      ["target", "taskId"],
      "pi_a2a_cancel",
    ],
  ].map(([name, description, properties, transport]) => ({
    name,
    label: name,
    description,
    parameters: schema(properties),
    replay: name === "a2a_cancel" ? "never" : "safe",
    async execute(_id, args, _update, _tools, _invocation, executionContext) {
      return toolResult(
        await invoke(transport, args, executionContext.abortSignal),
      );
    },
  }));
  tools.push({
    name: "a2a_call",
    label: "Call agent",
    description:
      "Delegate to an authorized agent:<id> or remote:<id> and wait for its real result. Do not include credentials.",
    parameters: schema(["target", "message"]),
    replay: "safe",
    async execute(_id, args, _update, _tools, invocation, executionContext) {
      const signal = executionContext.abortSignal;
      let memo = await invocation.getMemo("a2a-call");
      if (
        memo &&
        (memo.target !== args.target ||
          memo.message !== args.message ||
          (memo.taskId !== undefined && typeof memo.taskId !== "string"))
      )
        throw new Error(
          "Agent delegation memo does not match the original call.",
        );
      if (!memo) {
        memo = { target: args.target, message: args.message };
        await invocation.setMemo("a2a-call", memo);
      }
      if (!memo.taskId) {
        signal?.throwIfAborted();
        const submitted = await invoke(
          "pi_a2a_submit",
          {
            target: memo.target,
            message: memo.message,
            messageId: invocation.invocationId,
          },
          signal,
        );
        const taskId = submitted.taskId ?? submitted.task?.id;
        if (typeof taskId !== "string" || !taskId)
          throw new Error(
            "Agent submission did not return a public platform task ID.",
          );
        memo = { ...memo, taskId };
        await invocation.setMemo("a2a-call", memo);
      }
      for (;;) {
        signal?.throwIfAborted();
        const result = await invoke(
          "pi_a2a_status",
          { target: memo.target, taskId: memo.taskId },
          signal,
        );
        const state = stateOf(result);
        if (
          [
            "COMPLETED",
            "FAILED",
            "CANCELED",
            "REJECTED",
            "INPUT_REQUIRED",
            "AUTH_REQUIRED",
          ].includes(state)
        )
          return toolResult(result);
        if (!["SUBMITTED", "WORKING"].includes(state))
          throw new Error("Agent returned an unknown task state.");
        await sleep(1000, undefined, { signal });
      }
    },
  });
  return tools;
}

async function mcpTools(input, clients, origins) {
  const tools = [];
  let communicationClient;
  for (const [serverIndex, server] of (input.mcpServers ?? []).entries()) {
    const communication = server.deploymentId === "toolplane-a2a";
    if (communication && !input.communicationEnabled) continue;
    const url = new URL(server.url);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash
    )
      throw failure("PI_CONFIG_INVALID", "Invalid authorized MCP endpoint.");
    const client = new Client({
      name: "toolplane-pi-harness",
      version: "0.87.1",
    });
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: {
          headers: { authorization: `Bearer ${secret}` },
          redirect: "error",
        },
        fetch: (request, init) =>
          fetch(request, {
            ...init,
            redirect: "error",
            signal: init?.signal
              ? AbortSignal.any([init.signal, controller.signal])
              : controller.signal,
          }),
      }),
    );
    if (communication) {
      if (communicationClient)
        throw failure(
          "PI_CONFIG_INVALID",
          "More than one agent communication transport was authorized.",
        );
      communicationClient = client;
      continue;
    }
    let cursor;
    let toolIndex = 0;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined, {
        signal: controller.signal,
      });
      for (const remote of page.tools) {
        // Transport helpers are never a second model-visible communication surface.
        if (remote.name.startsWith("pi_a2a_")) continue;
        if (++toolIndex > 256 || tools.length >= 256)
          throw failure(
            "PI_CONFIG_INVALID",
            "Authorized MCP tool catalog exceeds its limit.",
          );
        const name = (
          `mcp__s${serverIndex + 1}_t${toolIndex}__` +
          remote.name.replace(/[^A-Za-z0-9_-]/g, "_")
        ).slice(0, 63);
        origins.set(name, {
          deploymentId: server.deploymentId,
          originalToolName: remote.name,
        });
        tools.push({
          name,
          label: remote.title ?? remote.name,
          description: remote.description ?? remote.name,
          parameters: remote.inputSchema,
          replay: "never",
          async execute(
            _id,
            args,
            _update,
            _tools,
            _invocation,
            executionContext,
          ) {
            const result = await client.callTool(
              { name: remote.name, arguments: args },
              undefined,
              { signal: executionContext.abortSignal },
            );
            if (result.isError)
              throw new Error(textOf(result.content) || "MCP tool failed.");
            const content = result.content.map((part) =>
              part.type === "text" || part.type === "image"
                ? part
                : { type: "text", text: JSON.stringify(part) },
            );
            if (result.structuredContent !== undefined)
              content.push({
                type: "text",
                text: JSON.stringify(result.structuredContent),
              });
            return { content, details: {} };
          },
        });
      }
      cursor = page.nextCursor;
    } while (cursor);
  }
  if (input.communicationEnabled) {
    if (!communicationClient)
      throw failure(
        "PI_CONFIG_INVALID",
        "Agent communication is enabled without an authorized transport.",
      );
    tools.push(...communicationTools(communicationClient));
  }
  return tools;
}

async function outcomeText(session, outcome) {
  if (!outcome.tipId || outcome.tipId === outcome.fromTipId)
    return outcome.error?.message ?? "";
  const entries = await session.scanBranch(
    {
      start: outcome.tipId,
      ...(outcome.fromTipId ? { stopAtId: outcome.fromTipId } : {}),
      order: "newestFirst",
    },
    context,
  );
  let resultText = "";
  let toolError = "";
  const warnings = [];
  for (const entry of entries) {
    if (entry.id === outcome.fromTipId) break;
    if (entry.type === "compaction" && !resultText) resultText = entry.summary;
    if (entry.type !== "message") continue;
    if (entry.message.role === "assistant" && !resultText)
      resultText = textOf(entry.message.content);
    if (entry.message.role === "toolResult" && entry.message.isError) {
      const text = textOf(entry.message.content);
      toolError ||= text;
      if (text.includes("external outcome is unknown")) warnings.push(text);
    }
  }
  return [
    ...warnings.reverse(),
    resultText || outcome.error?.message || toolError,
  ]
    .filter(Boolean)
    .filter((text, index, all) => all.indexOf(text) === index)
    .join("\n\n");
}

function observe(watch, model, origins) {
  const toolActivity = (tool, status) =>
    emit({
      type: "activity",
      activity: {
        type: "tool",
        status,
        toolCallId: tool.toolCallId,
        toolName: tool.toolName,
        ...origins.get(tool.toolName),
        ...(tool.args === undefined ? {} : { input: tool.args }),
        ...(tool.result === undefined
          ? {}
          : { output: tool.result, isError: tool.isError }),
      },
    });
  for (const tool of watch.snapshot.operation?.runningTools ?? [])
    toolActivity(
      tool,
      tool.status === "settled"
        ? tool.isError
          ? "failed"
          : "completed"
        : "running",
    );
  const boundary = watch.snapshot.operation?.fromTipId;
  const transcript = watch.snapshot.operation ? watch.snapshot.transcript : [];
  const start = boundary
    ? transcript.findIndex((entry) => entry.id === boundary) + 1
    : 0;
  for (const entry of transcript.slice(start)) {
    if (
      entry.type === "message" &&
      entry.message.role === "toolResult" &&
      entry.message.isError
    ) {
      toolActivity(
        { ...entry.message, result: { content: entry.message.content } },
        "failed",
      );
    }
  }
  if (watch.snapshot.operation?.streamingMessage) {
    const delta = textOf(watch.snapshot.operation.streamingMessage.content);
    if (delta) emit({ type: "text_delta", delta });
  }
  watch.start((event) => {
    if (event.type === "message_update") {
      if (event.event?.type === "text_delta")
        emit({ type: "text_delta", delta: event.event.delta });
      if (
        event.event?.type === "thinking_start" ||
        event.event?.type === "thinking_delta" ||
        event.event?.type === "thinking_end"
      )
        emit({
          type: "activity",
          activity: {
            type: "reasoning",
            status:
              event.event.type === "thinking_end" ? "completed" : "running",
            ...(event.event.delta ? { delta: event.event.delta } : {}),
          },
        });
    }
    if (event.type === "tool_start") toolActivity(event, "running");
    if (event.type === "tool_end")
      toolActivity(event, event.isError ? "failed" : "completed");
    if (event.type === "usage") {
      const usage = event.row.usage;
      emit({
        type: "usage",
        usage: {
          inputTokens: usage.input,
          outputTokens: usage.output,
          cacheReadTokens: usage.cacheRead,
          cacheWriteTokens: usage.cacheWrite,
          costUsd: usage.cost.total,
        },
      });
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      const usage = event.message.usage;
      const usedTokens = usage?.totalTokens;
      if (usedTokens > 0)
        emit({
          type: "context_usage",
          usage: {
            usedTokens,
            maxTokens: model.contextWindow,
            modelName: model.id,
            estimated: false,
          },
        });
    }
  });
}

async function main() {
  const input = JSON.parse(await readFile(process.argv[2], "utf8"));
  if (
    !["prepare", "run", "cancel", "compact"].includes(input.action) ||
    typeof input.directory !== "string" ||
    !input.directory ||
    typeof input.contextId !== "string" ||
    !input.contextId
  )
    throw failure(
      "PI_INPUT_INVALID",
      "Invalid native host action or session binding.",
    );
  if (
    !["prepare", "compact"].includes(input.action) &&
    (typeof input.operationId !== "string" || !input.operationId)
  )
    throw failure(
      "PI_INPUT_INVALID",
      "An existing operation binding is required.",
    );
  if (
    input.action === "compact" &&
    typeof input.customInstructions !== "string"
  )
    throw failure(
      "PI_INPUT_INVALID",
      "Compaction instructions must be a string.",
    );
  if (
    input.maxSteps !== undefined &&
    (!Number.isSafeInteger(input.maxSteps) || input.maxSteps < 1)
  )
    throw failure("PI_CONFIG_INVALID", "maxSteps must be a positive integer.");
  secret =
    input.runtimeAccessToken || process.env.TOOLPLANE_RUNTIME_TOKEN || "";
  if (secret) process.env.TOOLPLANE_RUNTIME_TOKEN = secret;
  if (input.nativeApprovalUrl)
    process.env.TOOLPLANE_APPROVAL_URL = input.nativeApprovalUrl;
  const repository = new SqliteSessionRepo({
    directory: input.directory,
    databaseFactory: createNodeSqliteFactory(),
  });
  const clients = [];
  let harness, watch;
  try {
    const session = await openSession(repository, input);
    if (input.action === "prepare") {
      emit({ type: "prepared", operationId: session.idGenerator.next() });
      return;
    }
    if (
      typeof input.modelsPath !== "string" ||
      typeof input.modelId !== "string" ||
      !input.modelId ||
      typeof input.workingDirectory !== "string"
    )
      throw failure(
        "PI_CONFIG_INVALID",
        "Explicit model configuration and working directory are required.",
      );
    const models = await ModelRuntime.create({
      modelsPath: input.modelsPath,
      allowModelNetwork: false,
      signal: controller.signal,
    });
    if (models.getError())
      throw failure(
        "PI_CONFIG_INVALID",
        "The authorized model configuration is invalid.",
      );
    const model = models.getModel(
      input.providerId ?? "toolplane",
      input.modelId,
    );
    if (!model)
      throw failure(
        "PI_MODEL_UNAVAILABLE",
        "The exact authorized model was not found.",
      );
    ({ harness } = await AgentHarness.create(
      {
        session,
        models,
        model,
        systemPrompt: async (_tools, promptContext) =>
          [
            input.systemPrompt ?? "",
            formatSkillsForSystemPrompt(
              (await harness.getResources(promptContext)).skills ?? [],
            ),
          ]
            .filter(Boolean)
            .join("\n\n"),
        ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
        toolExecution: "sequential",
      },
      context,
    ));
    const lane = await harness.lane("main", context);
    if (input.action === "compact") {
      const execution = await lane.inspectExecution(context);
      if (execution.current) {
        const meta = (
          await session.getValue(operationMeta(execution.current.id), context)
        )?.value;
        if (
          meta?.intent.kind !== "compaction" ||
          (meta.intent.customInstructions ?? "") !== input.customInstructions
        )
          throw failure(
            "PI_LANE_BUSY",
            "The main lane is executing a different operation or compaction instruction.",
          );
        input.operationId = execution.current.id;
      } else {
        input.operationId = session.idGenerator.next();
        await lane.setModel(
          { provider: model.provider, modelId: model.id },
          context,
        );
        unwrap(
          await lane.accept(
            {
              kind: "compaction",
              operationId: input.operationId,
              customInstructions: input.customInstructions,
            },
            context,
          ),
        );
      }
      watch = await lane.watch(context);
      observe(watch, model, new Map());
    }
    let outcome = await lane.getResult(input.operationId, context);
    if (!outcome) {
      const execution = await lane.inspectExecution(context);
      if (execution.current && execution.current.id !== input.operationId)
        throw failure(
          "PI_LANE_BUSY",
          "The main lane is executing a different operation.",
        );
      if (input.action === "run") {
        if (!secret || !process.env.TOOLPLANE_APPROVAL_URL)
          throw failure(
            "PI_CONFIG_INVALID",
            "Runtime authorization and native approval configuration are required.",
          );
        await approvalReady();
        const origins = new Map();
        const disabled = new Set(input.disabledBuiltinTools ?? []);
        const coding = createCodingTools(input.workingDirectory)
          .filter((tool) => !disabled.has(tool.name))
          .map((tool) => ({
            ...tool,
            replay: tool.replay ?? "never",
            execute: (
              id,
              args,
              update,
              _tools,
              _invocation,
              executionContext,
            ) => tool.execute(id, args, executionContext.abortSignal, update),
          }));
        const tools = [...coding, ...(await mcpTools(input, clients, origins))];
        const approvals = new Map();
        harness.hooks.on("before_tool", async (event, hookContext) => {
          const args = freezeArguments(event.args);
          if (
            !(await approveNativeTool(
              event.toolName,
              args,
              event.toolCallId,
              hookContext.abortSignal,
            ))
          ) {
            controller.signal.throwIfAborted();
            unwrap(await lane.requestAbort(event.runId, context));
            return {
              block: {
                reason:
                  "Tool execution was not approved. Review the request in the ToolPlane console.",
                terminate: true,
              },
            };
          }
          approvals.set(event.toolCallId, JSON.stringify(args));
        });
        await harness.setTools(
          tools.map((tool) => ({
            ...tool,
            async execute(
              id,
              args,
              update,
              toolContext,
              invocation,
              executionContext,
            ) {
              // Official safe replay bypasses before_tool. It still needs this driver's fresh lease.
              const serialized = JSON.stringify(args);
              if (approvals.get(id) !== serialized) {
                if (
                  !(await approveNativeTool(
                    tool.name,
                    freezeArguments(args),
                    id,
                    executionContext.abortSignal,
                  ))
                ) {
                  controller.signal.throwIfAborted();
                  unwrap(
                    await lane.requestAbort(invocation.operationId, context),
                  );
                  throw new Error(
                    "Tool execution was not approved under the current runtime lease.",
                  );
                }
              }
              approvals.delete(id);
              return tool.execute(
                id,
                args,
                update,
                toolContext,
                invocation,
                executionContext,
              );
            },
          })),
          context,
        );
        const skills = await Promise.all(
          (input.skills ?? []).map(async (skill) => ({
            name: skill.name,
            description: skill.description,
            filePath: skill.filePath,
            content: await readFile(skill.filePath, "utf8"),
          })),
        );
        await harness.setResources({ skills }, context);
        await lane.setActiveTools(
          tools.map((tool) => tool.name),
          context,
        );
        if (!execution.current) {
          await lane.setModel(
            { provider: model.provider, modelId: model.id },
            context,
          );
          if (input.thinkingLevel)
            await lane.setThinkingLevel(input.thinkingLevel, context);
        }
        if (input.maxSteps !== undefined)
          harness.hooks.on("before_request", async (event) => {
            if (event.step !== "assistant") return;
            const meta = (
              await session.getValue(operationMeta(event.runId), context)
            )?.value;
            if (!meta)
              throw failure(
                "PI_SESSION_CORRUPT",
                "Native operation metadata is missing.",
              );
            const entries = await lane.findEntries(
              {
                ...(meta.sourceTipId ? { stopAtId: meta.sourceTipId } : {}),
                type: "message",
              },
              context,
            );
            const steps = entries.filter(
              (entry) =>
                entry.id !== meta.sourceTipId &&
                entry.message.role === "assistant" &&
                !["error", "aborted"].includes(entry.message.stopReason),
            ).length;
            if (steps >= input.maxSteps)
              unwrap(await lane.requestAbort(event.runId, context));
          });
        watch = await lane.watch(context);
        observe(watch, model, origins);
      }
      if (!execution.current)
        unwrap(
          await lane.accept(
            {
              kind: "prompt",
              operationId: input.operationId,
              prompt: prompt(input),
            },
            context,
          ),
        );
      // A bound but not yet accepted cancellation is admitted then canceled before any drive.
      if (input.action === "cancel")
        unwrap(await lane.requestAbort(input.operationId, context));
      const driven = unwrap(
        await lane.drive(
          {
            operationId: input.operationId,
            waitForRetry: true,
            pollDeferred: true,
          },
          context,
        ),
      );
      if (driven.kind !== "settled")
        throw failure(
          "PI_OPERATION_OPEN",
          "Native operation remains open; no terminal status was projected.",
        );
      outcome = driven.outcome;
    }
    if (
      outcome.kind === "compaction" &&
      outcome.tipId &&
      outcome.tipId !== outcome.fromTipId
    ) {
      const entries = await session.scanBranch(
        {
          start: outcome.tipId,
          ...(outcome.fromTipId ? { stopAtId: outcome.fromTipId } : {}),
        },
        context,
      );
      const usage = entries.find((entry) => entry.type === "compaction")?.usage;
      if (usage)
        emit({
          type: "usage",
          usage: {
            inputTokens: usage.input,
            outputTokens: usage.output,
            cacheReadTokens: usage.cacheRead,
            cacheWriteTokens: usage.cacheWrite,
            costUsd: usage.cost.total,
          },
        });
    }
    emit({
      type: "result",
      operationId: input.operationId,
      status: outcome.status,
      text: await outcomeText(session, outcome),
    });
  } finally {
    watch?.unsubscribe();
    try {
      if (harness) await harness.close(BACKGROUND_CONTEXT);
    } finally {
      try {
        await repository.close(BACKGROUND_CONTEXT);
      } finally {
        await Promise.all(
          clients.map((client) => client.close().catch(() => {})),
        );
      }
    }
  }
}

try {
  await main();
} catch (error) {
  const corrupt =
    error.name === "HarnessFault" ||
    error.name === "SessionInvariantError" ||
    error.code === "ERR_SQLITE_ERROR";
  emit({
    type: "error",
    code: controller.signal.aborted
      ? "PI_DRIVER_INTERRUPTED"
      : error.code?.startsWith("PI_")
        ? error.code
        : corrupt
          ? "PI_SESSION_CORRUPT"
          : "PI_HOST_ERROR",
    message: controller.signal.aborted
      ? "Native driver interrupted; the operation remains recoverable."
      : corrupt
        ? "Native session storage is inconsistent; existing files were preserved."
        : error.message || "Native host failed.",
  });
  process.exitCode = 1;
}
