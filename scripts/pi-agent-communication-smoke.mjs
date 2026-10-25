#!/usr/bin/env node
/** Real paid-model native Pi SDK smoke. Existing disposable Agents and published
 * revisions only. Never edits Agent configuration, runtime ledger or ownership.
 * Required TOOLPLANE_SMOKE_*: BASE_URL, WORKSPACE_SLUG, AGENT_A_ID, AGENT_B_ID,
 * PERSONAL_TOKEN, DATABASE_URL (explicit local isolated test DB, read-only).
 * Artifacts and API-created tasks are retained for inspection. No crash replay probes.
 */
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  AgentCard,
  SendMessageRequest,
  GetTaskRequest,
  CancelTaskRequest,
  TaskState,
} from "@a2a-js/sdk";
import { ClientFactory, JsonRpcTransportFactory } from "@a2a-js/sdk/client";
const run = promisify(execFile);
const required = [
  "BASE_URL",
  "WORKSPACE_SLUG",
  "AGENT_A_ID",
  "AGENT_B_ID",
  "PERSONAL_TOKEN",
  "DATABASE_URL",
];
const assert = (condition, code) => {
  if (!condition) throw new Error(code);
};
const state = (task) =>
  typeof task.status?.state === "number"
    ? TaskState[task.status.state]
    : task.status?.state;
const terminal = (task) =>
  [
    "TASK_STATE_COMPLETED",
    "TASK_STATE_FAILED",
    "TASK_STATE_CANCELED",
    "TASK_STATE_REJECTED",
  ].includes(state(task));
const text = (task) =>
  (task.artifacts ?? [])
    .flatMap((artifact) => artifact.parts ?? [])
    .map((part) => part.text ?? "")
    .join("\n");
const report = (assertion, details = {}) =>
  console.log(JSON.stringify({ assertion, ...details }));
let interrupted = false;
process.once("SIGINT", () => {
  interrupted = true;
});
process.once("SIGTERM", () => {
  interrupted = true;
});
// Executed inside exactly the ledger-bound context sandbox, never the Agent template.
function inspectSession(input) {
  const fs = require("node:fs"),
    path = require("node:path");
  const root = `/workspace/.toolplane/runtimes/pi-sdk/agents/${input.agentId}`;
  const saved = JSON.parse(
    fs.readFileSync(`${root}/sessions/${input.contextId}.json`, "utf8"),
  );
  if (
    saved.runtimeKind !== "pi-sdk" ||
    saved.sdkVersion !== "0.87.1" ||
    !saved.sessionPersisted
  )
    throw Error("NATIVE_SDK_STATE_REQUIRED");
  const file = fs.realpathSync(saved.sessionFile);
  if (
    !file.startsWith(`${root}/sessions/${input.contextId}/`) ||
    fs.statSync(file).size > 16 * 1024 * 1024
  )
    throw Error("NATIVE_SESSION_SCOPE_INVALID");
  const messages = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.type === "message")
    .map((entry) => entry.message);
  const calls = messages
    .filter((message) => message.role === "assistant")
    .flatMap((message) => message.content ?? [])
    .filter((part) => part.type === "toolCall");
  const successful = new Set(
    messages
      .filter((message) => message.role === "toolResult" && !message.isError)
      .map((message) => message.toolCallId),
  );
  let fileMatches;
  if (input.file) {
    const actual = fs.realpathSync(input.file);
    if (
      actual !== path.resolve(input.file) ||
      !actual.startsWith("/workspace/pi-smoke-")
    )
      throw Error("SMOKE_FILE_SCOPE_INVALID");
    fileMatches = fs.readFileSync(actual, "utf8").trim() === input.marker;
  }
  process.stdout.write(
    JSON.stringify({
      sessionId: saved.sessionId,
      userCount: messages.filter((message) => message.role === "user").length,
      toolNames: calls.map((call) => call.name),
      successfulToolNames: calls
        .filter((call) => successful.has(call.id))
        .map((call) => call.name),
      ...(input.file ? { fileMatches } : {}),
    }),
  );
}
async function main() {
  if (process.argv.includes("--help")) {
    console.log(
      `Paid native Pi SDK A2A/tool/file/continuation smoke. Set ${required.map((key) => `TOOLPLANE_SMOKE_${key}`).join(", ")}. Existing Agents must start pi-smoke-disposable-, have published native Pi0.87.1 revisions and explicit A->B bounded policy. Explicit database must be local isolated test DB. No installation, configuration mutation, process kills or unknown-effect replay.`,
    );
    return;
  }
  const env = Object.fromEntries(
    required.map((key) => [key, process.env[`TOOLPLANE_SMOKE_${key}`]]),
  );
  for (const key of required) assert(env[key], `MISSING_${key}`);
  const base = new URL(env.BASE_URL),
    database = new URL(env.DATABASE_URL);
  assert(
    ["http:", "https:"].includes(base.protocol) &&
      !base.username &&
      !base.password &&
      base.pathname === "/" &&
      !base.search &&
      !base.hash,
    "INVALID_BASE_URL",
  );
  assert(
    ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname),
    "ISOLATED_LOCAL_APP_REQUIRED",
  );
  assert(
    ["localhost", "127.0.0.1", "[::1]"].includes(database.hostname) &&
      /test|acceptance|disposable/.test(database.pathname),
    "ISOLATED_LOCAL_DATABASE_REQUIRED",
  );
  assert(!/[\r\n]/.test(env.PERSONAL_TOKEN), "INVALID_TOKEN");
  for (const key of ["WORKSPACE_SLUG", "AGENT_A_ID", "AGENT_B_ID"])
    assert(/^[A-Za-z0-9_-]{1,120}$/.test(env[key]), "INVALID_IDENTIFIER");
  assert(env.AGENT_A_ID !== env.AGENT_B_ID, "DISTINCT_AGENTS_REQUIRED");
  database.searchParams.set(
    "options",
    `${database.searchParams.get("options") ?? ""} -c default_transaction_read_only=on`.trim(),
  );
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: database.href }),
  });
  const submitted = [];
  const origin = base.origin,
    workspaceUrl = `${origin}/api/v1/workspaces/${env.WORKSPACE_SLUG}`;
  const endpoint = (id) => `${workspaceUrl}/agents/${id}/a2a/local`;
  const endpoints = [endpoint(env.AGENT_A_ID), endpoint(env.AGENT_B_ID)];
  const authenticated = async (url, init = {}) => {
    const destination = new URL(url instanceof Request ? url.url : url);
    assert(
      endpoints.includes(destination.href) &&
        !destination.username &&
        !destination.password,
      "CREDENTIAL_ENDPOINT_MISMATCH",
    );
    return fetch(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: {
        ...Object.fromEntries(new Headers(init.headers)),
        authorization: `Bearer ${env.PERSONAL_TOKEN}`,
      },
    });
  };
  const clients = new Map();
  try {
    const workspace = await db.workspace.findUniqueOrThrow({
      where: { slug: env.WORKSPACE_SLUG },
    });
    const revisions = new Map();
    for (const id of [env.AGENT_A_ID, env.AGENT_B_ID]) {
      const agent = await db.agent.findFirstOrThrow({
        where: { id, workspaceId: workspace.id },
      });
      assert(
        [agent.name, agent.slug].some((name) =>
          name.startsWith("pi-smoke-disposable-"),
        ),
        "DISPOSABLE_AGENT_REQUIRED",
      );
      assert(
        agent.runtimeKind === "pi-sdk" &&
          !agent.retiredAt &&
          agent.providerId &&
          agent.model &&
          agent.currentRevisionVersion > 0 &&
          agent.a2aInboundEnabled,
        "PUBLISHED_CONFIGURED_PI_AGENT_REQUIRED",
      );
      const revision = await db.agentRevision.findUniqueOrThrow({
        where: {
          agentId_version: {
            agentId: id,
            version: agent.currentRevisionVersion,
          },
        },
      });
      const config = revision.config;
      assert(
        config.runtimeKind === "pi-sdk" &&
          config.environment.piVersion === "0.87.1" &&
          /@sha256:[a-f0-9]{64}$/.test(config.environment.image) &&
          config.a2a.inboundEnabled,
        "IMMUTABLE_NATIVE_REVISION_REQUIRED",
      );
      assert(
        !config.disabledBuiltinTools.includes("bash"),
        "AUTHORIZED_NATIVE_BASH_REQUIRED",
      );
      revisions.set(id, revision);
      const response = await authenticated(endpoint(id));
      assert(response.ok, "LOCAL_AGENT_CARD_UNAVAILABLE");
      const card = AgentCard.fromJSON(await response.json());
      assert(
        card.supportedInterfaces?.some((item) => item.url === endpoint(id)),
        "EXPECTED_LOCAL_AGENT_CARD_REQUIRED",
      );
      clients.set(
        id,
        await new ClientFactory({
          transports: [
            new JsonRpcTransportFactory({ fetchImpl: authenticated }),
          ],
        }).createFromAgentCard(card),
      );
    }
    const policy = revisions.get(env.AGENT_A_ID).config.a2a;
    const target = policy.policy.targets.find(
      (item) => item.kind === "local" && item.targetId === env.AGENT_B_ID,
    );
    assert(
      policy.outboundEnabled &&
        target &&
        target.maxCalls > 0 &&
        target.maxDepth > 0 &&
        target.maxConcurrent > 0 &&
        target.timeoutSeconds > 0 &&
        target.maxInputBytes > 0 &&
        target.dataAllowance === "text_only",
      "EXPLICIT_BOUNDED_A_TO_B_POLICY_REQUIRED",
    );
    const liveA = await db.agent.findUniqueOrThrow({
      where: { id: env.AGENT_A_ID },
    });
    assert(
      liveA.a2aOutboundEnabled &&
        liveA.a2aPolicy?.targets?.some(
          (item) => item.kind === "local" && item.targetId === env.AGENT_B_ID,
        ),
      "LIVE_A_TO_B_AUTHORIZATION_REQUIRED",
    );
    const request = (message, extra = {}) =>
      SendMessageRequest.fromJSON({
        message: {
          messageId: randomUUID(),
          role: "ROLE_USER",
          parts: [{ text: message }],
          ...extra,
        },
        configuration: {
          returnImmediately: true,
          acceptedOutputModes: ["text/plain"],
        },
      });
    const wait = async (client, id) => {
      const deadline = Date.now() + 300000;
      while (Date.now() < deadline) {
        assert(!interrupted, "OPERATOR_INTERRUPTED");
        const task = await client.getTask(GetTaskRequest.fromJSON({ id }));
        if (terminal(task)) {
          assert(
            state(task) === "TASK_STATE_COMPLETED",
            `TASK_NOT_COMPLETED_${state(task)}`,
          );
          return task;
        }
        assert(
          state(task) !== "TASK_STATE_INPUT_REQUIRED",
          "UNEXPECTED_INPUT_REQUIRED",
        );
        await sleep(1000);
      }
      throw Error("TASK_TIMEOUT_UNKNOWN_OUTCOME");
    };
    const inspect = async (row, file, marker) => {
      const ledger = await db.a2ATask.findUniqueOrThrow({
        where: { id: row.id },
      });
      assert(
        ledger.contextId === row.contextId &&
          ledger.executionBackend === "pi-sdk",
        "NATIVE_SDK_LEDGER_REQUIRED",
      );
      const context = await db.a2AContext.findUniqueOrThrow({
        where: { id: row.contextId },
      });
      assert(
        context.agentRevisionId === revisions.get(context.agentId)?.id &&
          context.sandboxId &&
          !context.legacyRevisionUnresolved,
        "PINNED_CONTEXT_SANDBOX_REQUIRED",
      );
      const container = `toolplane-sandbox-${context.sandboxId.replace(/[^a-zA-Z0-9_.-]/g, "_")}`;
      const result = await run(
        "docker",
        [
          "exec",
          container,
          "node",
          "-e",
          `(${inspectSession.toString()})(JSON.parse(process.argv[1]))`,
          JSON.stringify({
            agentId: context.agentId,
            contextId: context.id,
            file,
            marker,
          }),
        ],
        { timeout: 15000, maxBuffer: 1024 * 1024 },
      );
      return { ...JSON.parse(result.stdout), sandboxId: context.sandboxId };
    };
    const stamp = randomUUID().replaceAll("-", ""),
      marker = `PI_SDK_SMOKE_${stamp}`,
      file = `/workspace/pi-smoke-${stamp}.txt`;
    const command = `printf '%s\\n' '${marker}' > '${file}'; cat '${file}'`;
    const rootRequest = request(
      `Use the available native Agent communication submit/send tool to delegate exactly one task to agent:${env.AGENT_B_ID}. Child instruction: Run the native bash tool exactly once with command ${JSON.stringify(command)}, then return the actual tool output including ${marker}. Await the actual child result using the supported task wait/status tools; do not simulate or claim success without a completed child. Finish with the child's actual result and its task ID. Do not access credentials or make other side effects.`,
    );
    const a = clients.get(env.AGENT_A_ID);
    const receipt = await a.sendMessage(rootRequest);
    assert(receipt.id && receipt.contextId, "TASK_RECEIPT_REQUIRED");
    submitted.push({ client: a, id: receipt.id });
    assert(
      (await a.sendMessage(rootRequest)).id === receipt.id,
      "MESSAGE_IDEMPOTENCY_FAILED",
    );
    const root = await wait(a, receipt.id);
    assert(text(root).includes(marker), "ACTUAL_CHILD_RESULT_REQUIRED");
    const children = await db.a2ATask.findMany({
      where: { parentTaskId: root.id },
      include: { context: true },
    });
    assert(
      children.length === 1 &&
        children[0].context.agentId === env.AGENT_B_ID &&
        children[0].state === TaskState.TASK_STATE_COMPLETED,
      "ONE_REAL_COMPLETED_DELEGATION_REQUIRED",
    );
    const child = children[0];
    const childEvidence = await inspect(child, file, marker),
      rootEvidence = await inspect(root);
    assert(
      childEvidence.fileMatches &&
        childEvidence.successfulToolNames.includes("bash"),
      "NATIVE_TOOL_AND_FILE_EVIDENCE_REQUIRED",
    );
    assert(
      rootEvidence.successfulToolNames.some((name) => name.includes("a2a")) &&
        rootEvidence.sandboxId !== childEvidence.sandboxId,
      "ISOLATED_NATIVE_DELEGATION_EVIDENCE_REQUIRED",
    );
    report(
      "PASS native A-to-B delegation, tool, file and isolated pinned contexts",
      {
        taskId: root.id,
        childTaskId: child.id,
        contextId: root.contextId,
        childContextId: child.contextId,
      },
    );
    const continuationRequest = request(
      `Without tools or delegation, recall the exact PI_SDK_SMOKE marker and child task ID returned in this context's prior turn. Return only those two values.`,
      { contextId: root.contextId, referenceTaskIds: [root.id] },
    );
    const continuedReceipt = await a.sendMessage(continuationRequest);
    submitted.push({ client: a, id: continuedReceipt.id });
    assert(
      continuedReceipt.contextId === root.contextId &&
        continuedReceipt.id !== root.id,
      "SAME_CONTEXT_NEW_TASK_REQUIRED",
    );
    const continued = await wait(a, continuedReceipt.id);
    assert(
      text(continued).includes(marker) && text(continued).includes(child.id),
      "RETAINED_NATIVE_CONTEXT_MEMORY_REQUIRED",
    );
    const continuedEvidence = await inspect(continued);
    assert(
      continuedEvidence.sessionId === rootEvidence.sessionId &&
        continuedEvidence.sandboxId === rootEvidence.sandboxId &&
        continuedEvidence.userCount > rootEvidence.userCount,
      "NATIVE_SESSION_CONTINUITY_REQUIRED",
    );
    assert(
      (await db.a2ATask.count({ where: { parentTaskId: continued.id } })) === 0,
      "CONTINUATION_MUST_NOT_REDELEGATE",
    );
    for (const [id, revision] of revisions)
      assert(
        (await db.agent.findUniqueOrThrow({ where: { id } }))
          .currentRevisionVersion === revision.version,
        "SMOKE_MUST_NOT_CHANGE_CONFIG",
      );
    report("PASS retained same-context native continuation", {
      taskId: continued.id,
      contextId: continued.contextId,
      sessionId: continuedEvidence.sessionId,
    });
  } finally {
    for (const { client, id } of submitted) {
      try {
        const task = await client.getTask(GetTaskRequest.fromJSON({ id }));
        if (!terminal(task))
          await client.cancelTask(CancelTaskRequest.fromJSON({ id }));
      } catch {
        report("CLEANUP_UNCONFIRMED_UNKNOWN_OUTCOME", { taskId: id });
      }
    }
    await db.$disconnect();
  }
}
main().catch((error) => {
  report("FAIL", {
    code: error.message?.match(/^[A-Z][A-Z0-9_]+$/)
      ? error.message
      : "SMOKE_FAILED",
  });
  process.exitCode = 1;
});
