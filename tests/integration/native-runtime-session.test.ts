// @vitest-environment node
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { stopNativeSessionHosts } from "../../scripts/native-runtime-stop.mjs";

it("stops only one conversation's resident SDK host while preserving its sibling and saved native state", async () => {
  const root = await mkdtemp(join(tmpdir(), "toolplane-session-stop-"));
  const driver = join(process.cwd(), "scripts/native-runtime-session.mjs");
  const host = join(process.cwd(), "scripts/pi-sdk-session.mjs");
  const daemons: ChildProcess[] = [];
  const environment = {
    ...process.env,
    NODE_CHANNEL_FD: undefined,
    NODE_CHANNEL_SERIALIZATION_MODE: undefined,
  };
  const prepare = async (name: string) => {
    const cwd = join(root, name, "workspace");
    const stateRoot = join(root, name, ".toolplane", "runtime");
    const configPath = join(stateRoot, "host", "native.json");
    const statePath = join(stateRoot, "sessions", "native.json");
    const socketPath = `/tmp/toolplane-runtime-${createHash("sha256").update(statePath).digest("hex").slice(0, 32)}.sock`;
    await Promise.all(
      [cwd, join(stateRoot, "host"), join(stateRoot, "sessions", "native")].map(
        (path) => mkdir(path, { recursive: true }),
      ),
    );
    const extension = join(cwd, "counter.mjs");
    const factory = join(stateRoot, "host", "mcp.mjs");
    await writeFile(
      extension,
      "export default pi => { let count=0; pi.registerCommand('Ping',{handler:async()=>{ pi.sendMessage({customType:'counter',content:'count='+ ++count,display:true}); }}); };",
    );
    await writeFile(
      factory,
      "export async function createPiMcpTools(){ return []; }",
    );
    const model = {
      id: "test",
      name: "Test",
      api: "openai-completions",
      provider: "toolplane",
      baseUrl: "http://127.0.0.1:1/v1",
      reasoning: false,
      input: ["text"],
      contextWindow: 32768,
      maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    await writeFile(
      configPath,
      JSON.stringify({
        sdkVersion: "0.87.1",
        packageRoot: process.cwd(),
        cwd,
        agentDir: stateRoot,
        sessionsDir: join(stateRoot, "sessions", "native"),
        statePath,
        packageSetChecksum: "empty",
        agentRevisionId: "pinned",
        model,
        systemPrompt: "Counter fixture",
        defaultTools: [],
        excludeTools: [],
        packages: [],
        resources: {
          extensions: [extension],
          skills: [],
          prompts: [],
          themes: [],
        },
        packageVerifierPath: join(
          process.cwd(),
          "scripts/pi-sdk-package-files.mjs",
        ),
        mcpFactoryPath: factory,
        hostOnlyCommands: [],
      }),
    );
    const inputPath = join(root, name, "request.json");
    await writeFile(
      inputPath,
      JSON.stringify({
        kind: "pi-sdk",
        binary: process.execPath,
        args: [host, configPath],
        cwd,
        statePath,
        signature: name,
        command: "/Ping",
        context: {
          runtimeToken: `token-${name}`,
          model,
          mcpConfig: { servers: [] },
        },
      }),
    );
    const daemon = spawn(process.execPath, [driver, inputPath, "serve"], {
      stdio: "ignore",
      env: environment,
    });
    daemons.push(daemon);
    await expect
      .poll(() => existsSync(socketPath), { timeout: 10000 })
      .toBe(true);
    const request = async () => {
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [driver, inputPath],
        { timeout: 20000, env: environment },
      );
      const result = stdout.trim().split("\n").at(-1);
      if (!result) throw new Error("Native runtime returned no response");
      return JSON.parse(result);
    };
    return { stateRoot, statePath, socketPath, daemon, request };
  };
  try {
    const first = await prepare("first");
    const second = await prepare("second");
    expect(await first.request()).toMatchObject({
      success: true,
      result: { text: expect.stringContaining("count=1") },
    });
    expect(await second.request()).toMatchObject({
      success: true,
      result: { text: expect.stringContaining("count=1") },
    });
    const stopped = once(first.daemon, "exit");
    await stopNativeSessionHosts(first.stateRoot);
    await stopped;
    expect(existsSync(first.socketPath)).toBe(false);
    expect(existsSync(first.statePath)).toBe(true);
    expect(existsSync(second.socketPath)).toBe(true);
    expect(await second.request()).toMatchObject({
      success: true,
      result: { text: expect.stringContaining("count=2") },
    });
    await stopNativeSessionHosts(first.stateRoot);
  } finally {
    await Promise.all(
      daemons.map(async (daemon) => {
        if (daemon.exitCode !== null || daemon.signalCode !== null) return;
        const stopped = once(daemon, "exit");
        daemon.kill("SIGTERM");
        await stopped;
      }),
    );
    await rm(root, { recursive: true, force: true });
  }
}, 60000);

it("settles real SDK commands without agent_end, rotates context, and kills disconnected process groups", async () => {
  const dir = await mkdtemp(join(tmpdir(), "toolplane-sdk-daemon-"));
  const driver = join(process.cwd(), "scripts/native-runtime-session.mjs");
  const host = join(process.cwd(), "scripts/pi-sdk-session.mjs");
  const statePath = join(dir, "state.json");
  const socketPath = `/tmp/toolplane-runtime-${createHash("sha256").update(statePath).digest("hex").slice(0, 32)}.sock`;
  const inputPath = join(dir, "input.json");
  const configPath = join(dir, "config.json");
  const extension = join(dir, "extension.mjs");
  const started = join(dir, "started");
  await mkdir(join(dir, "sessions"));
  await mkdir(join(dir, "agent"));
  await writeFile(
    join(dir, "mcp.mjs"),
    "export async function createPiMcpTools() { return []; }",
  );
  await writeFile(
    extension,
    `
import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
export default function(pi) {
  let count = 0;
  pi.registerCommand('Case', { description: 'real command', handler: async () => {
    count++;
    pi.sendMessage({ customType: 'daemon-test', content: 'count=' + count, display: true });
    console.log('untrusted stdout must not become protocol');
    writeFileSync(${JSON.stringify(join(dir, "context"))}, process.env.TOOLPLANE_RUNTIME_TOKEN);
  }});
  pi.registerCommand('Wait', { handler: async () => {
    const child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { stdio: ['pipe', 'ignore', 'ignore'] });
    writeFileSync(${JSON.stringify(started)}, String(child.pid));
    await Promise.withResolvers().promise;
  }});
}
`,
  );
  await writeFile(
    configPath,
    JSON.stringify({
      sdkVersion: "0.87.1",
      packageRoot: process.cwd(),
      cwd: dir,
      agentDir: join(dir, "agent"),
      sessionsDir: join(dir, "sessions"),
      statePath,
      packageSetChecksum: "empty-package-set",
      model: {
        id: "test",
        name: "Test",
        api: "openai-completions",
        provider: "toolplane",
        baseUrl: "http://127.0.0.1:1/v1",
        reasoning: false,
        input: ["text"],
        contextWindow: 32768,
        maxTokens: 1024,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      systemPrompt: "SDK daemon command fixture",
      defaultTools: [],
      excludeTools: [],
      resources: {
        extensions: [extension],
        skills: [],
        prompts: [],
        themes: [],
      },
      packages: [],
      packageVerifierPath: join(
        process.cwd(),
        "scripts/pi-sdk-package-files.mjs",
      ),
      mcpFactoryPath: join(dir, "mcp.mjs"),
      hostOnlyCommands: [],
    }),
  );
  const job = {
    kind: "pi-sdk",
    binary: process.execPath,
    args: [host, configPath],
    sdkConfigPath: configPath,
    packageRoot: process.cwd(),
    statePath,
    signature: "sdk-stable",
    command: "/Case",
    message: "",
    history: [{ role: "user", text: "never seeded" }],
    context: {
      runtimeToken: "first-test-token",
      mcpConfig: { servers: [] },
      model: JSON.parse(await readFile(configPath, "utf8")).model,
    },
  };
  await writeFile(inputPath, JSON.stringify(job));
  let daemon = spawn(process.execPath, [driver, inputPath, "serve"], {
    stdio: "ignore",
  });
  const until = async (predicate: () => boolean) => {
    const deadline = Date.now() + 15_000;
    // Real detached processes/filesystem signals cannot be driven with Vitest fake clocks.
    while (!predicate()) {
      if (Date.now() > deadline)
        throw new Error("SDK daemon fixture timed out");
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 20);
      await promise;
    }
  };
  try {
    await until(() => existsSync(socketPath));
    const run = async () => {
      await writeFile(inputPath, JSON.stringify(job));
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [driver, inputPath],
        { timeout: 20_000 },
      );
      return stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    };
    const first = await run();
    const response = first.filter(
      (event) => event.type === "toolplane_sdk_response",
    );
    expect(response).toHaveLength(1);
    expect(response[0], JSON.stringify(response[0])).toMatchObject({
      success: true,
      result: {
        text: expect.stringContaining("count=1"),
        commands: expect.arrayContaining([
          { name: "Case", description: "real command" },
        ]),
        commandResult: {
          command: "Case",
          text: expect.stringContaining("count=1"),
          status: "completed",
        },
      },
    });
    expect(response[0].result).not.toHaveProperty("state");
    expect(JSON.stringify(first)).not.toContain("untrusted stdout");
    expect(first.some((event) => event.type === "agent_end")).toBe(false);
    const sdkState = JSON.parse(await readFile(statePath, "utf8"));
    expect(sdkState).toMatchObject({
      runtimeKind: "pi-sdk",
      sdkVersion: "0.87.1",
      sessionPersisted: false,
    });
    expect(sdkState).not.toHaveProperty("seeded");
    // Command lookup is case-sensitive and failures use the SDK response envelope.
    job.command = "/case";
    const unsupported = await run();
    expect(unsupported).toEqual([
      {
        type: "toolplane_sdk_response",
        id: expect.any(String),
        success: false,
        error: {
          code: "PI_SDK_COMMAND_UNKNOWN",
          message: "PI_SDK_COMMAND_UNKNOWN",
        },
      },
    ]);
    expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual(sdkState);
    job.command = "/Case";
    job.context.runtimeToken = "second-test-token";
    const second = await run();
    expect(
      second.find((event) => event.type === "toolplane_sdk_response"),
    ).toMatchObject({
      success: true,
      result: {
        text: expect.stringContaining("count=2"),
        commandResult: {
          command: "Case",
          text: expect.stringContaining("count=2"),
          status: "completed",
        },
      },
    });
    expect(await readFile(join(dir, "context"), "utf8")).toBe(
      "second-test-token",
    );
    expect(await readFile(statePath, "utf8")).not.toContain("test-token");
    const socket = createConnection(socketPath);
    await once(socket, "connect");
    socket.write(`${JSON.stringify({ ...job, command: "/Wait" })}\n`);
    await until(() => existsSync(started));
    const descendantPid = Number(await readFile(started, "utf8"));
    // A second socket must not attach to an already-running SDK request.
    const busy = await run();
    expect(busy).toEqual([
      {
        type: "toolplane_sdk_response",
        success: false,
        error: { code: "PI_SDK_BUSY", message: "PI_SDK_BUSY" },
      },
    ]);
    const stopped = once(daemon, "exit");
    socket.destroy();
    await stopped;
    expect(existsSync(socketPath)).toBe(false);
    await until(() => {
      try {
        process.kill(descendantPid, 0);
        return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
        throw error;
      }
    });
    daemon = spawn(process.execPath, [driver, inputPath, "serve"], {
      stdio: "ignore",
    });
    await until(() => existsSync(socketPath));
    const lost = await run();
    expect(
      lost.find((event) => event.type === "toolplane_sdk_response"),
    ).toMatchObject({
      success: false,
      error: {
        code: "PI_SDK_SESSION_MISSING",
        message: "PI_SDK_SESSION_MISSING",
      },
    });
    // A revision participates in the production signature. An idle old broker
    // must stop before a changed toolset can reach its already-created SDK host.
    const upgradeSocket = createConnection(socketPath);
    await once(upgradeSocket, "connect");
    const upgradeResponse = once(upgradeSocket, "data");
    const upgradedHostStopped = once(daemon, "exit");
    upgradeSocket.write(
      `${JSON.stringify({ ...job, signature: "sdk-new-revision" })}\n`,
    );
    expect(JSON.parse(String((await upgradeResponse)[0]).trim())).toEqual({
      type: "toolplane_session_restart",
    });
    await upgradedHostStopped;
    expect(existsSync(socketPath)).toBe(false);
  } finally {
    // Ask the daemon to stop its detached host process group before removing files.
    if (daemon.exitCode === null && daemon.signalCode === null) {
      const stopped = once(daemon, "exit");
      daemon.kill("SIGTERM");
      await stopped;
    }
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);
