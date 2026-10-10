#!/usr/bin/env node
/**
 * Real, paid-model integration smoke; never a substitute for unit tests.
 * Required environment: TOOLPLANE_SMOKE_BASE_URL, TOOLPLANE_SMOKE_WORKSPACE_SLUG,
 * TOOLPLANE_SMOKE_AGENT_A_ID, TOOLPLANE_SMOKE_AGENT_B_ID, TOOLPLANE_SMOKE_PERSONAL_TOKEN.
 * Crash checks additionally require TOOLPLANE_SMOKE_ALLOW_PROCESS_KILL=1.
 * Both existing Agents must have a name or slug starting pi-smoke-disposable-,
 * distinct running Docker sandboxes, configured Pi models, and A -> B permission.
 * This script never changes Agent configuration or makes approval decisions.
 * Only a verified child of a tracked exec for this run can receive SIGKILL.
 * Native SQLite is inspected read-only, never through a second SessionRepo writer.
 */
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import {
  AgentCard,
  SendMessageRequest,
  GetTaskRequest,
  CancelTaskRequest,
  TaskState,
} from "@a2a-js/sdk";
import { ClientFactory, JsonRpcTransportFactory } from "@a2a-js/sdk/client";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createInterface } from "node:readline/promises";

const run = promisify(execFile);
const limit = 300_000;
const packageRoot = "/workspace/.toolplane/runtime-packages/pi-harness-0.87.1";
const submitted = [];
let interrupted = false;
process.once("SIGINT", () => {
  interrupted = true;
});
process.once("SIGTERM", () => {
  interrupted = true;
});
const required = [
  "BASE_URL",
  "WORKSPACE_SLUG",
  "AGENT_A_ID",
  "AGENT_B_ID",
  "PERSONAL_TOKEN",
];
const help = `Real Pi communication smoke (paid models, Docker and PostgreSQL required).
Set ${required.map((key) => `TOOLPLANE_SMOKE_${key}`).join(", ")}.
Set TOOLPLANE_SMOKE_ALLOW_PROCESS_KILL=1 to authorize the required crash scenario.
Both Agents must be disposable: name or slug starts pi-smoke-disposable-.
Use two distinct running Docker sandboxes; authorize only A -> B.
Authenticated A2A roots and delegated children authorize their configured tools without a human decision.
Interactive chat/Work approval decisions are covered separately, not by this A2A runner.
The crash guard checks tracked wrapper ancestry, exact host/config paths, Agent,
task/context/operation IDs and committed SQLite settlement + assistant.effect_pending.
If that boundary is missed, the check fails without killing another process.
For owner restart, stop only your isolated test app when prompted; restart when told.
The runner requires observed API downtime and driver exit, then same-operation recovery.
It never stops a server, takes over ownership, or approves tools.
Fixtures and Agent configuration are retained for inspection; no user resources are deleted.`;
const assert = (ok, code) => {
  if (!ok) throw Object.assign(new Error(code), { smokeCode: code });
};
const report = (assertion, task) =>
  console.log(
    JSON.stringify({
      assertion,
      ...(task
        ? {
            taskId: task.id,
            ...(task.nativeOperationId
              ? { operationId: task.nativeOperationId }
              : {}),
          }
        : {}),
    }),
  );
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
    .flatMap((item) => item.parts ?? [])
    .map((part) => part.text ?? "")
    .join("\n");

// Runs only inside the selected sandbox. Nothing in its output contains a config or credential.
async function inspectNative(input) {
  const fs = await import("node:fs");
  const { DatabaseSync } = await import("node:sqlite");
  const { operationState, operationResult, operationToolMemoPrefix } =
    await import(
      input.packageRoot +
        "/node_modules/@earendil-works/pi-agent-core/dist/index.js"
    );
  const root = `/workspace/.toolplane/runtimes/pi/agents/${input.agentId}/harness`;
  const check = (ok) => {
    if (!ok) throw new Error("NATIVE_SCOPE_CHECK_FAILED");
  };
  check(/^[a-zA-Z0-9_-]{1,120}$/.test(input.agentId));
  check(!input.contextId || /^[a-zA-Z0-9_-]{1,200}$/.test(input.contextId));
  const host = `${input.packageRoot}/pi-harness-session.mjs`;
  const missing = (error) => error.code === "ENOENT" || error.code === "ESRCH";
  const read = (path) => {
    try {
      return fs.readFileSync(path, "utf8");
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  };
  const processes = [];
  for (const file of fs
    .readdirSync("/tmp")
    .filter((name) => /^toolplane-runtime-[a-zA-Z0-9-]+\.pid$/.test(name))) {
    const pidText = read(`/tmp/${file}`)?.trim();
    if (!/^[1-9][0-9]*$/.test(pidText ?? "")) continue;
    const wrapper = Number(pidText);
    const wrapperCommand = read(`/proc/${wrapper}/cmdline`);
    const wrapperArgs = wrapperCommand?.split("\0").filter(Boolean) ?? [];
    if (
      wrapperArgs.length !== 8 ||
      !/(?:^|\/)sh$/.test(wrapperArgs[0]) ||
      wrapperArgs[1] !== "-c" ||
      wrapperArgs[3] !== "toolplane-runtime" ||
      wrapperArgs[4] !== `/tmp/${file}` ||
      wrapperArgs[5] !== "node" ||
      wrapperArgs[6] !== host
    )
      continue;
    const wrapperStat = read(`/proc/${wrapper}/stat`);
    if (!wrapperStat) continue;
    const children =
      read(`/proc/${wrapper}/task/${wrapper}/children`)?.trim().split(/\s+/) ??
      [];
    for (const child of children) {
      if (!/^[1-9][0-9]*$/.test(child)) continue;
      const command = read(`/proc/${child}/cmdline`);
      if (!command) continue;
      const args = command.split("\0").filter(Boolean);
      if (
        args.length !== 3 ||
        !/(?:^|\/)node$/.test(args[0]) ||
        args[1] !== host ||
        !/^\/workspace\/\.toolplane\/runtime-tmp\/[a-f0-9-]+-pi-harness\.json$/.test(
          args[2],
        ) ||
        wrapperArgs[7] !== args[2]
      )
        continue;
      const raw = read(args[2]);
      if (!raw) continue;
      const config = JSON.parse(raw);
      if (
        config.action !== "run" ||
        config.taskId !== input.taskId ||
        (input.contextId && config.contextId !== input.contextId) ||
        (input.operationId && config.operationId !== input.operationId) ||
        config.directory !== root ||
        config.packageRoot !== input.packageRoot
      )
        continue;
      check(
        /^[a-zA-Z0-9_-]{1,200}$/.test(config.contextId) &&
          /^[a-zA-Z0-9_-]{1,200}$/.test(config.operationId),
      );
      const stat = read(`/proc/${child}/stat`);
      if (!stat) continue;
      processes.push({
        pid: Number(child),
        wrapper,
        pidFile: `/tmp/${file}`,
        command,
        start: stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19],
        wrapperCommand,
        wrapperStart: wrapperStat
          .slice(wrapperStat.lastIndexOf(")") + 2)
          .split(" ")[19],
        configPath: args[2],
        configText: raw,
        contextId: config.contextId,
        operationId: config.operationId,
      });
    }
  }
  check(processes.length <= 1);
  const identity = processes[0];
  if (!input.operationId && !identity) {
    console.log(JSON.stringify({ live: 0 }));
    return;
  }
  input.contextId ??= identity.contextId;
  input.operationId ??= identity.operationId;
  const children = new Set(),
    childResults = [];
  const dbPath = `${root}/${input.contextId}.sqlite`;
  let result = null,
    phase = null,
    settled = false;
  if (fs.existsSync(dbPath)) {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      db.exec("BEGIN");
      check(
        db
          .prepare("SELECT storage_version FROM sessions WHERE id = ?")
          .get(input.contextId)?.storage_version === 4,
      );
      const scalar = (address) => {
        const row = db
          .prepare(
            "SELECT value FROM scalar_values WHERE session_id = ? AND namespace = ? AND key = ?",
          )
          .get(input.contextId, address.namespace, address.key);
        return row ? JSON.parse(row.value) : null;
      };
      phase = scalar(operationState(input.operationId))?.at ?? null;
      result = scalar(operationResult(input.operationId))?.status ?? null;
      const messages = db
        .prepare(
          "SELECT payload FROM entries WHERE session_id = ? AND type = 'message' ORDER BY seq",
        )
        .all(input.contextId)
        .map((row) => JSON.parse(row.payload).message);
      const calls = new Set(
        messages
          .filter((message) => message?.role === "assistant")
          .flatMap((message) => message.content ?? [])
          .filter(
            (part) =>
              part.type === "toolCall" &&
              JSON.stringify(part.arguments).includes(input.fixture),
          )
          .map((part) => part.id),
      );
      const results = messages.filter(
        (message) =>
          message?.role === "toolResult" && calls.has(message.toolCallId),
      );
      settled = results.some(
        (message) =>
          !message.isError &&
          (message.content ?? []).some((part) =>
            part.text?.includes(input.marker),
          ),
      );
      const prefix = operationToolMemoPrefix(input.operationId);
      for (const row of db
        .prepare(
          "SELECT key, value FROM scalar_values WHERE session_id = ? AND namespace = ?",
        )
        .all(input.contextId, prefix.namespace)) {
        if (!row.key.startsWith(prefix.key)) continue;
        const memo = JSON.parse(row.value);
        if (memo.target === input.target && typeof memo.taskId === "string")
          children.add(memo.taskId);
      }
      const delegations = new Set(
        messages
          .filter((message) => message?.role === "assistant")
          .flatMap((message) => message.content ?? [])
          .filter(
            (part) =>
              part.type === "toolCall" &&
              part.name === "a2a_call" &&
              part.arguments?.target === input.target,
          )
          .map((part) => part.id),
      );
      for (const message of messages.filter(
        (message) =>
          message?.role === "toolResult" &&
          !message.isError &&
          delegations.has(message.toolCallId),
      )) {
        for (const part of message.content ?? [])
          if (part.type === "text") {
            let projection;
            try {
              projection = JSON.parse(part.text);
            } catch {
              continue;
            }
            const task = projection.task;
            if (typeof task?.id !== "string") continue;
            childResults.push({
              id: task.id,
              contextId: task.contextId,
              state: task.status?.state,
              markerPresent: (task.artifacts ?? []).some((artifact) =>
                (artifact.parts ?? []).some((part) =>
                  part.text?.includes(input.marker),
                ),
              ),
            });
          }
      }
      db.exec("ROLLBACK");
    } finally {
      db.close();
    }
  } else if (input.requireDatabase) throw new Error("NATIVE_DATABASE_MISSING");
  let count = 0;
  const counter = read(input.fixture);
  if (counter !== null) {
    const lines = counter.split("\n").filter(Boolean);
    check(lines.every((line) => line === input.marker));
    count = lines.length;
  }
  let killed = false;
  if (
    input.kill &&
    count === 1 &&
    settled &&
    phase === "assistant.effect_pending" &&
    !result &&
    processes.length === 1
  ) {
    check(input.allowKill === true);
    const p = processes[0];
    // Revalidate identity immediately before signalling; no PID from output is trusted later.
    check(read(p.pidFile)?.trim() === String(p.wrapper));
    check(read(p.configPath) === p.configText);
    check(read(`/proc/${p.wrapper}/cmdline`) === p.wrapperCommand);
    const wrapperStat = read(`/proc/${p.wrapper}/stat`);
    check(
      wrapperStat &&
        wrapperStat.slice(wrapperStat.lastIndexOf(")") + 2).split(" ")[19] ===
          p.wrapperStart,
    );
    check(read(`/proc/${p.pid}/cmdline`) === p.command);
    const stat = read(`/proc/${p.pid}/stat`);
    check(
      stat && stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] === p.start,
    );
    check(
      (read(`/proc/${p.wrapper}/task/${p.wrapper}/children`) ?? "")
        .trim()
        .split(/\s+/)
        .includes(String(p.pid)),
    );
    process.kill(p.pid, "SIGKILL");
    killed = true;
  }
  console.log(
    JSON.stringify({
      taskId: input.taskId,
      contextId: input.contextId,
      operationId: input.operationId,
      live: processes.length,
      phase,
      result,
      settled,
      count,
      killed,
      children: [...children],
      childResults,
    }),
  );
}

async function main() {
  if (process.argv.includes("--help")) {
    console.log(help);
    return;
  }
  const env = Object.fromEntries(
    required.map((key) => [key, process.env[`TOOLPLANE_SMOKE_${key}`]]),
  );
  const absent = required.filter((key) => !env[key]?.trim());
  assert(
    !absent.length,
    "MISSING_INPUTS: " +
      absent.map((key) => `TOOLPLANE_SMOKE_${key}`).join(", "),
  );
  assert(
    process.env.TOOLPLANE_SMOKE_ALLOW_PROCESS_KILL === "1",
    "CRASH_OPT_IN_REQUIRED: TOOLPLANE_SMOKE_ALLOW_PROCESS_KILL=1",
  );
  assert(process.stdin.isTTY, "INTERACTIVE_OPERATOR_REQUIRED");
  const [major, minor] = process.versions.node.split(".").map(Number);
  assert(
    major > 22 || (major === 22 && minor >= 19),
    "NODE_22_19_OR_NEWER_REQUIRED",
  );
  const base = new URL(env.BASE_URL);
  assert(
    ["http:", "https:"].includes(base.protocol) &&
      !base.username &&
      !base.password &&
      base.pathname === "/" &&
      !base.search &&
      !base.hash,
    "BASE_URL_MUST_BE_ORIGIN",
  );
  assert(
    base.protocol === "https:" ||
      ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname),
    "HTTPS_REQUIRED_FOR_REMOTE_PERSONAL_TOKEN",
  );
  assert(!/[\r\n]/.test(env.PERSONAL_TOKEN), "INVALID_PERSONAL_TOKEN");
  for (const key of ["WORKSPACE_SLUG", "AGENT_A_ID", "AGENT_B_ID"])
    assert(/^[a-zA-Z0-9_-]{1,120}$/.test(env[key]), "INVALID_IDENTIFIER");
  assert(env.AGENT_A_ID !== env.AGENT_B_ID, "DISTINCT_AGENTS_REQUIRED");
  const origin = base.origin,
    workspace = `${origin}/api/v1/workspaces/${env.WORKSPACE_SLUG}`;
  const api = (id) => `${workspace}/agents/${id}/a2a`;
  const consoleUrl = (id, taskId) =>
    origin +
    "/app/" +
    env.WORKSPACE_SLUG +
    "/agents/" +
    id +
    "?settings=a2a&task=" +
    taskId;
  const localEndpoints = [env.AGENT_A_ID, env.AGENT_B_ID].map(
    (id) => `${api(id)}/local`,
  );
  const authenticated = async (url, init = {}) => {
    const destination = new URL(url instanceof Request ? url.url : url);
    assert(
      destination.origin === origin &&
        !destination.username &&
        !destination.password,
      "CREDENTIAL_ORIGIN_MISMATCH",
    );
    assert(
      [`${workspace}/agents/mcp`, ...localEndpoints].includes(
        destination.origin + destination.pathname,
      ),
      "CREDENTIAL_ENDPOINT_MISMATCH",
    );
    return fetch(url, {
      ...init,
      redirect: "error",
      signal: init.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(15_000)])
        : AbortSignal.timeout(15_000),
      headers: {
        ...Object.fromEntries(new Headers(init.headers)),
        authorization: `Bearer ${env.PERSONAL_TOKEN}`,
      },
    });
  };
  const json = async (url) => {
    const response = await authenticated(url);
    assert(response.ok, `HTTP_READ_FAILED_${response.status}`);
    return response.json();
  };
  const docker = async (args) => {
    try {
      return (
        await run("docker", args, {
          timeout: 15_000,
          maxBuffer: 2 * 1024 * 1024,
        })
      ).stdout.trim();
    } catch {
      throw Object.assign(new Error("DOCKER_INSPECTION_FAILED"), {
        smokeCode: "DOCKER_INSPECTION_FAILED",
      });
    }
  };
  await docker(["info", "--format", "{{.ServerVersion}}"]);
  const mcp = new Client({
    name: "toolplane-pi-communication-smoke",
    version: "1",
  });
  await mcp.connect(
    new StreamableHTTPClientTransport(new URL(`${workspace}/agents/mcp`), {
      fetch: authenticated,
    }),
  );
  const agents = new Map();
  try {
    for (const id of [env.AGENT_A_ID, env.AGENT_B_ID]) {
      const response = await mcp.callTool(
        { name: "get_agent", arguments: { agentId: id } },
        undefined,
        { timeout: 15_000 },
      );
      assert(!response.isError, "AGENT_CONFIGURATION_UNAVAILABLE");
      const value =
        response.structuredContent?.result ??
        JSON.parse(
          response.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join(""),
        );
      const agent = value.agent ?? value;
      assert(
        agent.runtime?.kind === "pi" && agent.configured === true,
        "CONFIGURED_PI_MODEL_REQUIRED",
      );
      assert(
        [agent.name, agent.slug].some(
          (value) =>
            typeof value === "string" &&
            value.startsWith("pi-smoke-disposable-"),
        ),
        "DISPOSABLE_AGENT_NAME_REQUIRED",
      );
      const sandboxes = agent.resources?.sandboxes;
      assert(
        Array.isArray(sandboxes) &&
          sandboxes.length === 1 &&
          sandboxes[0].kind === "docker",
        "ONE_DOCKER_SANDBOX_REQUIRED",
      );
      const container = `toolplane-sandbox-${sandboxes[0].id.replace(/[^a-zA-Z0-9_.-]/g, "_")}`;
      assert(
        (await docker([
          "inspect",
          "--format",
          "{{.State.Running}}",
          container,
        ])) === "true",
        "RUNNING_SANDBOX_REQUIRED",
      );
      agents.set(id, { ...agent, container });
    }
  } finally {
    await mcp.close();
  }
  assert(
    agents.get(env.AGENT_A_ID).container !==
      agents.get(env.AGENT_B_ID).container,
    "DISTINCT_SANDBOXES_REQUIRED",
  );
  assert(
    agents
      .get(env.AGENT_A_ID)
      .resources.subAgents.some(
        (agent) =>
          agent.id === env.AGENT_B_ID || agent.agentId === env.AGENT_B_ID,
      ),
    "AUTHORIZED_A_TO_B_REQUIRED",
  );

  const clients = new Map();
  const cards = new Map();
  function clientFrom(card, token = true, headers = {}, observed = () => {}) {
    return new ClientFactory({
      transports: [
        new JsonRpcTransportFactory({
          fetchImpl: async (url, init) => {
            const destination = new URL(url instanceof Request ? url.url : url);
            assert(
              destination.origin === origin &&
                !destination.username &&
                !destination.password,
              "SDK_ORIGIN_MISMATCH",
            );
            assert(
              localEndpoints.includes(
                destination.origin + destination.pathname,
              ),
              "SDK_LOCAL_ENDPOINT_REQUIRED",
            );
            const response = await fetch(url, {
              ...init,
              redirect: "error",
              signal: AbortSignal.timeout(15_000),
              headers: {
                ...Object.fromEntries(new Headers(init?.headers)),
                ...(token
                  ? { authorization: `Bearer ${env.PERSONAL_TOKEN}` }
                  : {}),
                ...headers,
              },
            });
            observed(response.status);
            return response;
          },
        }),
      ],
    }).createFromAgentCard(AgentCard.fromJSON(card));
  }
  for (const id of agents.keys()) {
    const card = await json(`${api(id)}/local`);
    assert(
      card.supportedInterfaces?.some((item) => item.url === `${api(id)}/local`),
      "EXPECTED_LOCAL_AGENT_CARD_REQUIRED",
    );
    cards.set(id, card);
    clients.set(id, await clientFrom(card));
  }
  const request = (message, messageId = randomUUID()) =>
    SendMessageRequest.fromJSON({
      message: { messageId, role: "ROLE_USER", parts: [{ text: message }] },
      configuration: {
        returnImmediately: true,
        acceptedOutputModes: ["text/plain"],
      },
    });
  for (const [token, headers, expected] of [
    [false, {}, 401],
    [true, { origin: "https://pi-smoke-denied.invalid" }, 403],
  ]) {
    let rejected = false,
      httpStatus;
    const bad = await clientFrom(
      cards.get(env.AGENT_A_ID),
      token,
      headers,
      (status) => {
        httpStatus = status;
      },
    );
    try {
      await bad.sendMessage(
        request("Do not execute: authorization-negative smoke request."),
      );
    } catch {
      rejected = true;
    }
    assert(
      rejected && httpStatus === expected,
      "INBOUND_AUTHORIZATION_REJECTION_NOT_PROVEN",
    );
  }
  report("PASS no-token and disallowed-Origin inbound rejection");

  // Console BFF is session-only. Humans use its URL; this runner never borrows cookies
  // or runtime tokens. Owned public child receipts come from A's native invocation memo.
  async function operatorConfirmation(taskId, decision) {
    const prompt = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      const answer = await prompt.question(
        `Confirm your actual operator action for task ${taskId} (including its child if present). Type ${decision} ${taskId}: `,
        { signal: AbortSignal.timeout(limit) },
      );
      assert(
        answer.trim() === `${decision} ${taskId}`,
        "EXPLICIT_OPERATOR_DECISION_REQUIRED",
      );
    } finally {
      prompt.close();
    }
  }
  const native = async (node, fixture, marker, kill = false, target) => {
    assert(agents.has(node.agentId) && node.id, "OWNED_TASK_BINDING_REQUIRED");
    const input = {
      packageRoot,
      agentId: node.agentId,
      taskId: node.id,
      contextId: node.contextId,
      operationId: node.nativeOperationId,
      fixture,
      marker,
      target,
      kill,
      allowKill: true,
      requireDatabase: Boolean(node.nativeOperationId),
    };
    return JSON.parse(
      await docker([
        "exec",
        agents.get(node.agentId).container,
        "node",
        "--disable-warning=ExperimentalWarning",
        "--input-type=module",
        "-e",
        "(" +
          inspectNative.toString() +
          ")(JSON.parse(process.argv[1])).catch(() => process.exit(1))",
        JSON.stringify(input),
      ]),
    );
  };
  const bind = (node, probe) => {
    assert(
      probe.taskId === node.id && probe.contextId && probe.operationId,
      "NATIVE_TASK_BINDING_REQUIRED",
    );
    assert(
      !node.contextId || node.contextId === probe.contextId,
      "CONTEXT_BINDING_CHANGED",
    );
    assert(
      !node.nativeOperationId || node.nativeOperationId === probe.operationId,
      "OPERATION_BINDING_CHANGED",
    );
    return {
      ...node,
      contextId: probe.contextId,
      nativeOperationId: probe.operationId,
    };
  };
  async function until(fn, code) {
    const deadline = Date.now() + limit;
    while (Date.now() < deadline) {
      assert(!interrupted, "OPERATOR_INTERRUPTED");
      const found = await fn();
      if (found) return found;
      await sleep(2000);
    }
    assert(false, code);
  }
  async function submit(agentId, prompt) {
    const req = request(prompt),
      task = await clients.get(agentId).sendMessage(req);
    assert(task.id && task.status, "TASK_RECEIPT_REQUIRED");
    submitted.push({ client: clients.get(agentId), id: task.id });
    report("SUBMITTED", task);
    console.log(
      JSON.stringify({
        assertion: "OPERATOR_CONSOLE",
        taskId: task.id,
        consoleTaskUrl: consoleUrl(agentId, task.id),
      }),
    );
    return { task, req };
  }
  const stamp = randomUUID().replaceAll("-", "");
  const fixture = `/workspace/.toolplane/pi-smoke-${stamp}.count`;
  const marker = `PI_SMOKE_${stamp}`;
  const countedCommand = `printf '%s\n' '${marker}' >> '${fixture}'; cat '${fixture}'`;
  const root = await submit(
    env.AGENT_A_ID,
    `Use a2a_call exactly once to delegate to agent:${env.AGENT_B_ID}. Send this exact instruction: Run bash exactly once with command ${JSON.stringify(countedCommand)}. This is a counted side effect: never repeat it, including after interruption. Once the tool returns, produce a long explanation (at least 2000 words) of safe recovery without any further tools, then finish with ${marker}. Wait for the actual child result and include ${marker} in your final response. Never simulate the child or write the file yourself.`,
  );
  assert(
    (await clients.get(env.AGENT_A_ID).sendMessage(root.req)).id ===
      root.task.id,
    "ROOT_MESSAGE_DEDUPLICATION_FAILED",
  );
  report("PASS identical messageId returns identical task", root.task);
  let parent = {
      id: root.task.id,
      contextId: root.task.contextId,
      agentId: env.AGENT_A_ID,
    },
    binding;
  await until(async () => {
    const task = await clients
      .get(env.AGENT_A_ID)
      .getTask(GetTaskRequest.fromJSON({ id: root.task.id }));
    const parentProbe = await native(
      parent,
      fixture,
      marker,
      false,
      `agent:${env.AGENT_B_ID}`,
    );
    if (!parentProbe.operationId) {
      assert(!terminal(task), "PARENT_BINDING_CAPTURE_MISSED");
      return false;
    }
    parent = bind(parent, parentProbe);
    assert(parentProbe.children.length <= 1, "DUPLICATE_CHILD_TASK");
    const id = parentProbe.children[0];
    if (!id) {
      assert(!terminal(task), "CHILD_MEMO_CAPTURE_MISSED");
      return false;
    }
    assert(!binding || binding.id === id, "CHILD_RECEIPT_CHANGED");
    const node = binding ?? { id, agentId: env.AGENT_B_ID };
    const probe = await native(node, fixture, marker, true);
    if (probe.operationId) binding = bind(node, probe);
    if (!probe.killed) {
      assert(!terminal(task), "REQUIRED_CRASH_BOUNDARY_MISSED");
      return false;
    }
    report(
      "PASS settled counter=1 and assistant.effect_pending observed; scoped SIGKILL delivered",
      binding,
    );
    return true;
  }, "REQUIRED_CRASH_BOUNDARY_NOT_OBSERVED");
  const finished = await until(async () => {
    const task = await clients
      .get(env.AGENT_A_ID)
      .getTask(GetTaskRequest.fromJSON({ id: root.task.id }));
    assert(task.contextId === parent.contextId, "ROOT_CONTEXT_CHANGED");
    const childProbe = await native(binding, fixture, marker);
    bind(binding, childProbe);
    assert(childProbe.count === 1, "SETTLED_COUNTER_REPLAYED");
    if (!terminal(task)) return false;
    assert(
      state(task) === "TASK_STATE_COMPLETED" && text(task).includes(marker),
      "DELEGATION_DID_NOT_COMPLETE_WITH_MARKER",
    );
    assert(
      childProbe.result === "completed",
      "CHILD_NATIVE_COMPLETION_MISSING",
    );
    const parentProbe = await native(
      parent,
      fixture,
      marker,
      false,
      `agent:${env.AGENT_B_ID}`,
    );
    assert(
      parentProbe.result === "completed",
      "PARENT_NATIVE_COMPLETION_MISSING",
    );
    const child = parentProbe.childResults.find(
      (child) => child.id === binding.id,
    );
    assert(
      child &&
        child.contextId === binding.contextId &&
        state({ status: { state: child.state } }) === "TASK_STATE_COMPLETED" &&
        child.markerPresent,
      "CHILD_OWNED_PROJECTION_MISSING",
    );
    return task;
  }, "NATIVE_RECOVERY_TIMEOUT");
  report(
    "PASS same task/context/operation recovered; child count remains one; parent contains actual child output",
    finished,
  );

  const cancelFile = `/workspace/.toolplane/pi-smoke-${stamp}.cancel`;
  const cancelMarker = `CANCEL_${stamp}`;
  const cancellation = await submit(
    env.AGENT_B_ID,
    `Run bash with command ${JSON.stringify(`while true; do printf '%s\n' '${cancelMarker}' >> '${cancelFile}'; sleep 1; done`)}. Wait for the tool; do not start another tool or background process. The operator will cancel this smoke task.`,
  );
  let cancelNode = {
    id: cancellation.task.id,
    contextId: cancellation.task.contextId,
    agentId: env.AGENT_B_ID,
  };
  await until(async () => {
    const probe = await native(cancelNode, cancelFile, cancelMarker);
    if (probe.operationId) cancelNode = bind(cancelNode, probe);
    return probe.count > 0 && probe.live === 1;
  }, "CANCEL_EXECUTION_NEVER_STARTED");
  await clients
    .get(env.AGENT_B_ID)
    .cancelTask(CancelTaskRequest.fromJSON({ id: cancellation.task.id }));
  await until(async () => {
    const task = await clients
      .get(env.AGENT_B_ID)
      .getTask(GetTaskRequest.fromJSON({ id: cancellation.task.id }));
    if (!terminal(task)) return false;
    assert(state(task) === "TASK_STATE_CANCELED", "CANCELLATION_NOT_CONFIRMED");
    const probe = await native(cancelNode, cancelFile, cancelMarker);
    return probe.live === 0 && probe.result === "aborted";
  }, "CANCEL_EXECUTION_NOT_STOPPED");
  const stopped = await native(cancelNode, cancelFile, cancelMarker);
  await sleep(5000);
  assert(
    (await native(cancelNode, cancelFile, cancelMarker)).count ===
      stopped.count,
    "CANCELLED_EFFECT_STILL_RUNNING",
  );
  assert(
    state(
      await clients
        .get(env.AGENT_B_ID)
        .getTask(GetTaskRequest.fromJSON({ id: cancellation.task.id })),
    ) === "TASK_STATE_CANCELED",
    "CANCELED_STATE_NOT_PERSISTED",
  );
  report(
    "PASS SDK cancel confirmed by native aborted result, absent driver and stopped filesystem effect",
    cancelNode,
  );

  const restartFile = `/workspace/.toolplane/pi-smoke-${stamp}.restart`;
  const restartMarker = `RESTART_${stamp}`;
  const restart = await submit(
    env.AGENT_B_ID,
    `Run bash exactly once with command ${JSON.stringify(`printf '%s\n' '${restartMarker}' >> '${restartFile}'; cat '${restartFile}'`)}. Never repeat this counted side effect, including after interruption. After the tool returns, produce at least 4000 words about safe recovery without any further tools, then finish with ${restartMarker}. The operator will restart the platform during your response.`,
  );
  let restartNode = {
    id: restart.task.id,
    contextId: restart.task.contextId,
    agentId: env.AGENT_B_ID,
  };
  await until(async () => {
    const task = await clients
      .get(env.AGENT_B_ID)
      .getTask(GetTaskRequest.fromJSON({ id: restartNode.id }));
    assert(!terminal(task), "RESTART_BOUNDARY_MISSED");
    const probe = await native(restartNode, restartFile, restartMarker);
    if (probe.operationId) restartNode = bind(restartNode, probe);
    return (
      probe.live === 1 &&
      probe.count === 1 &&
      probe.settled &&
      probe.phase === "assistant.effect_pending" &&
      !probe.result
    );
  }, "RESTART_BOUNDARY_NOT_OBSERVED");
  report(
    "OPERATOR_STOP_REQUIRED: stop only the isolated test app/runtime-owner now; keep Docker and this runner running; do NOT restart until prompted",
    restartNode,
  );
  const platformAvailable = async () => {
    let response;
    try {
      response = await authenticated(`${api(env.AGENT_B_ID)}/local`);
    } catch (error) {
      if (error.name === "TypeError" || error.name === "TimeoutError")
        return false;
      throw error;
    }
    await response.body?.cancel();
    if ([502, 503, 504].includes(response.status)) return false;
    assert(response.ok, `RESTART_PROBE_HTTP_FAILED_${response.status}`);
    return true;
  };
  await until(async () => {
    const available = await platformAvailable();
    const probe = await native(restartNode, restartFile, restartMarker);
    bind(restartNode, probe);
    assert(
      probe.count === 1 && probe.settled,
      "RESTART_SETTLED_EFFECT_CHANGED",
    );
    assert(!probe.result, "RESTART_TERMINATED_INSTEAD_OF_PAUSED");
    return !available && probe.live === 0;
  }, "PLATFORM_DOWNTIME_AND_DRIVER_EXIT_NOT_OBSERVED");
  await operatorConfirmation(restartNode.id, "STOPPED");
  report(
    "PASS API unavailable and native driver absent with unfinished original operation; OPERATOR_START_REQUIRED: start the same isolated test app normally, without takeover or resubmission",
    restartNode,
  );
  await until(platformAvailable, "PLATFORM_DID_NOT_RETURN");
  await until(async () => {
    const task = await clients
      .get(env.AGENT_B_ID)
      .getTask(GetTaskRequest.fromJSON({ id: restartNode.id }));
    assert(
      task.id === restartNode.id && task.contextId === restartNode.contextId,
      "RESTART_TASK_OR_CONTEXT_CHANGED",
    );
    const probe = await native(restartNode, restartFile, restartMarker);
    bind(restartNode, probe);
    assert(
      probe.count === 1 && probe.settled,
      "RESTART_SETTLED_EFFECT_REPLAYED",
    );
    if (!terminal(task)) return false;
    assert(
      state(task) === "TASK_STATE_COMPLETED" &&
        text(task).includes(restartMarker) &&
        probe.result === "completed",
      "RESTART_NATIVE_COMPLETION_MISSING",
    );
    return true;
  }, "PLATFORM_RESTART_RECOVERY_TIMEOUT");
  await operatorConfirmation(restartNode.id, "RESTARTED");
  const canceledAfterRestart = await native(
    cancelNode,
    cancelFile,
    cancelMarker,
  );
  assert(
    canceledAfterRestart.result === "aborted" &&
      canceledAfterRestart.live === 0 &&
      canceledAfterRestart.count === stopped.count &&
      state(
        await clients
          .get(env.AGENT_B_ID)
          .getTask(GetTaskRequest.fromJSON({ id: cancelNode.id })),
      ) === "TASK_STATE_CANCELED",
    "CANCELED_TASK_REVIVED_AFTER_RESTART",
  );
  report(
    "PASS operator-assisted platform restart recovered same task/context/operation with count one; cancellation remains aborted",
    restartNode,
  );
  report(
    "NOT_RUN remote HTTPS and other-account authorization scenarios; no claim of remote exactly-once",
  );
  report(
    "PASS real-model SDK inbound without human approval, delegation, scoped process crash recovery, cancellation and operator-assisted platform restart",
  );
}

main().catch(async (error) => {
  // Never print SDK/provider/exec exception messages: those may contain tokens or model input.
  console.error(
    JSON.stringify({
      assertion: "FAIL",
      reason:
        error.smokeCode ??
        "SMOKE_FAILED: inspect server logs privately; no E2E success claimed",
    }),
  );
  process.exitCode = 1;
  // Cancellation is limited to receipts created here; never kill a server or guessed PID.
  for (const { client, id } of submitted) {
    try {
      let task = await client.getTask(GetTaskRequest.fromJSON({ id }));
      if (!terminal(task)) {
        await client.cancelTask(CancelTaskRequest.fromJSON({ id }));
        const deadline = Date.now() + 30_000;
        do {
          task = await client.getTask(GetTaskRequest.fromJSON({ id }));
          if (terminal(task)) break;
          await sleep(1000);
        } while (Date.now() < deadline);
      }
      report(
        terminal(task)
          ? "Cleanup task terminal; fixtures retained"
          : "FAIL cleanup cancellation unconfirmed; operator action required",
        { id },
      );
    } catch {
      report("FAIL cleanup unavailable; operator action required", { id });
    }
  }
});
