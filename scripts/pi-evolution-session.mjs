// Executed only in an immutable credential-free Pi SDK image with --network none,
// read-only root and private tmpfs. The host relays model HTTP over stdio; no key
// or host filesystem is ever made available to the model's tools.
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { findPackageJSON } from "node:module";
import { pathToFileURL } from "node:url";
const sdkEntry = realpathSync(
  "/opt/pi-sdk/node_modules/@earendil-works/pi-coding-agent/dist/index.js",
);
// The image uses a package-manager-selected transitive dependency location.
const sdk = await import(pathToFileURL(sdkEntry).href);
const { InMemoryCredentialStore } = await import(
  pathToFileURL(
    resolve(
      dirname(
        findPackageJSON("@earendil-works/pi-ai", pathToFileURL(sdkEntry)),
      ),
      "dist/index.js",
    ),
  ).href
);
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const lines = createInterface({ input: process.stdin });
let finished = false;
lines.on("close", () => {
  if (!finished) process.exit(1);
});
let setup;
const pending = new Map();
let sequence = 0;
lines.on("line", (line) => {
  const value = JSON.parse(line);
  if (value.type === "setup") {
    if (setup) {
      process.exit(1);
    }
    setup = value;
    void run().catch(() => {
      emit({ type: "failed" });
      process.exit(1);
    });
  }
  if (value.type === "response") {
    const response = pending.get(value.id);
    pending.delete(value.id);
    if (response) {
      response.writeHead(value.status, { "content-type": value.contentType });
      response.end(Buffer.from(value.body, "base64"));
    }
  }
});
async function run() {
  mkdirSync("/workspace/agent", { recursive: true });
  const skillPaths = [];
  for (const [index, skill] of (setup.skills ?? []).entries()) {
    const root = `/workspace/skills/${index}`;
    mkdirSync(root, { recursive: true });
    writeFileSync(`${root}/SKILL.md`, skill.markdown);
    for (const file of skill.files ?? []) {
      const destination = resolve(root, file.path);
      if (
        !destination.startsWith(`${root}/`) ||
        destination === `${root}/SKILL.md`
      )
        throw new Error("SKILL_SCOPE");
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(
        destination,
        file.encoding === "base64"
          ? Buffer.from(file.content, "base64")
          : file.content,
      );
    }
    skillPaths.push(root);
  }
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 2_000_000) {
        res.writeHead(413);
        res.end();
        return;
      }
    }
    const id = ++sequence;
    pending.set(id, res);
    emit({ type: "request", id, path: req.url, body });
  });
  const listening = Promise.withResolvers();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const model = {
    ...setup.model,
    provider: "toolplane",
    baseUrl: `http://127.0.0.1:${server.address().port}`,
  };
  const modelRuntime = await sdk.ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    modelsStorePath: "/workspace/agent/models.json",
    refreshOnCreate: false,
  });
  modelRuntime.registerProvider("toolplane", {
    baseUrl: model.baseUrl,
    api: model.api,
    apiKey: "isolated-relay",
    models: [model],
  });
  await modelRuntime.setRuntimeApiKey("toolplane", "isolated-relay");
  const services = await sdk.createAgentSessionServices({
    cwd: "/workspace",
    agentDir: "/workspace/agent",
    modelRuntime,
    settingsManager: sdk.SettingsManager.inMemory({
      retry: { enabled: false },
      compaction: { enabled: false },
    }),
    resourceLoaderOptions: {
      noExtensions: true,
      noSkills: true,
      additionalSkillPaths: skillPaths,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: setup.systemPrompt,
    },
  });
  let replayFailure = false;
  const canonical = (value) =>
    value && typeof value === "object"
      ? Array.isArray(value)
        ? `[${value.map(canonical).join(",")}]`
        : `{${Object.keys(value)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
            .join(",")}}`
      : JSON.stringify(value);
  const used = new Set();
  const nativeTools = new Set(setup.nativeTools ?? []);
  const customTools = (setup.recordedTools ?? []).map((tool) => ({
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    async execute(_callId, args) {
      const match = tool.calls.findIndex(
        (call) => canonical(call.arguments) === canonical(args),
      );
      if (match < 0) {
        replayFailure = true;
        throw new Error("RECORDED_TOOL_ARGUMENT_MISMATCH");
      }
      const recording = tool.calls.splice(match, 1)[0];
      used.add(tool.name);
      if (recording.isError)
        throw new Error(
          typeof recording.result === "string"
            ? recording.result
            : JSON.stringify(recording.result),
        );
      return {
        content: [
          {
            type: "text",
            text:
              typeof recording.result === "string"
                ? recording.result
                : JSON.stringify(recording.result),
          },
        ],
        details: recording.result,
      };
    },
  }));
  const result = await sdk.createAgentSessionFromServices({
    services,
    sessionManager: sdk.SessionManager.create(
      "/workspace",
      "/workspace/sessions",
    ),
    model,
    excludeTools: setup.excludeTools ?? [],
    customTools,
  });
  let text = "",
    failure = false,
    turns = 0;
  const usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  result.session.subscribe((event) => {
    if (
      event.type === "tool_execution_end" &&
      nativeTools.has(event.toolName)
    ) {
      used.add(event.toolName);
    }
    if (
      event.type === "message_end" &&
      event.message.role === "toolResult" &&
      event.message.isError &&
      !(setup.recordedTools ?? []).some(
        (tool) => tool.name === event.message.toolName,
      ) &&
      !nativeTools.has(event.message.toolName)
    )
      replayFailure = true;
    if (
      event.type === "tool_execution_end" &&
      event.isError &&
      !(setup.recordedTools ?? []).some(
        (tool) => tool.name === event.toolName,
      ) &&
      !nativeTools.has(event.toolName)
    )
      replayFailure = true;
    if (event.type === "message_end" && event.message.role === "assistant") {
      turns++;
      const m = event.message;
      if (m.stopReason === "error" || m.stopReason === "aborted")
        failure = true;
      text = (m.content ?? [])
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("\n");
      usage.inputTokens += m.usage?.input ?? 0;
      usage.outputTokens += m.usage?.output ?? 0;
      usage.cacheReadTokens += m.usage?.cacheRead ?? 0;
      usage.cacheWriteTokens += m.usage?.cacheWrite ?? 0;
      if (
        turns >= setup.maxSteps &&
        (m.content ?? []).some((p) => p.type === "toolCall")
      ) {
        failure = true;
        void result.session.abort();
      }
    }
  });
  await result.session.prompt(setup.input);
  const missingRequired = (setup.requiredTools ?? []).some(
    (name) => !used.has(name),
  );
  emit({
    type: "result",
    text,
    usage,
    failed: failure || replayFailure || missingRequired,
    failureCode: replayFailure
      ? "TOOL_REPLAY_MISMATCH"
      : missingRequired
        ? "EVALUATION_UNSUPPORTED_CAPABILITY"
        : failure
          ? "PI_EXECUTION_FAILED"
          : null,
  });
  await result.session.dispose?.();
  finished = true;
  server.close();
  lines.close();
  process.exit(0);
}
