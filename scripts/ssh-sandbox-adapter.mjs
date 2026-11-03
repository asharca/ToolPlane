import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

// Read lazily so server code can import the argument builder without the worker.
let worker;
const workerSource = () =>
  (worker ??= readFileSync(
    new URL("./ssh-sandbox-worker.py", import.meta.url),
    "utf8",
  ));
const MAX_RESPONSE = 7_500_000;
const TOOLS = new Set([
  "sandbox_info",
  "shell_exec",
  "process_exec",
  "list_dir",
  "read_file",
  "write_file",
  "download_file",
  "delete_file",
]);
const quote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

const ABSOLUTE_PATH = (value) =>
  typeof value === "string" &&
  value.startsWith("/") &&
  value.length <= 2048 &&
  !/[^\x20-\uFFFF]|[\x7f\\]/.test(value) &&
  !value.split("/").includes("..");

export function validateSshTarget(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("SSH target is not configured.");
  const {
    host,
    username,
    root,
    identityFile,
    knownHostsFile,
    askpassFile,
    hostKeyAlias,
    authType = "key",
    port = 22,
  } = raw;
  if (
    typeof host !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9.:-]{0,252}$/.test(host)
  )
    throw new Error("Invalid SSH host.");
  if (
    typeof username !== "string" ||
    !/^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$/.test(username)
  )
    throw new Error("Invalid SSH username.");
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid SSH port.");
  if (authType !== "key" && authType !== "password")
    throw new Error("Invalid SSH authentication type.");
  // Password logins never carry an identity; key logins always do.
  if ((authType === "key") !== (identityFile !== undefined))
    throw new Error("Invalid SSH credential configuration.");
  if (authType === "password" && askpassFile === undefined)
    throw new Error("Invalid SSH credential configuration.");
  const credentialPaths = [knownHostsFile, identityFile, askpassFile].filter(
    (value) => value !== undefined,
  );
  for (const value of [root, ...credentialPaths]) {
    if (!ABSOLUTE_PATH(value))
      throw new Error(
        "SSH paths must be absolute POSIX paths without parent traversal.",
      );
  }
  // OpenSSH config option values containing whitespace have parser-specific
  // quoting. Keep credential paths unambiguous; remote workspace allows spaces.
  if (credentialPaths.some((value) => /\s/.test(value)))
    throw new Error("SSH credential paths cannot contain whitespace.");
  if (
    hostKeyAlias !== undefined &&
    (typeof hostKeyAlias !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(hostKeyAlias))
  )
    throw new Error("Invalid SSH host key alias.");
  return {
    host,
    username,
    root,
    knownHostsFile,
    port,
    authType,
    ...(identityFile === undefined ? {} : { identityFile }),
    ...(askpassFile === undefined ? {} : { askpassFile }),
    ...(hostKeyAlias === undefined ? {} : { hostKeyAlias }),
  };
}

/** Fixed local environment; secrets reach OpenSSH only through the askpass file. */
export function sshEnvironment(raw) {
  const target = validateSshTarget(raw);
  return {
    PATH: "/usr/bin:/bin",
    LANG: "C.UTF-8",
    HOME: "/nonexistent",
    ...(target.askpassFile
      ? { SSH_ASKPASS: target.askpassFile, SSH_ASKPASS_REQUIRE: "force" }
      : {}),
  };
}

export function sshArguments(raw, remoteCommand, terminal = false) {
  const target = validateSshTarget(raw);
  const key = target.authType === "key";
  return [
    "-F",
    "/dev/null",
    terminal ? "-tt" : "-T",
    "-e",
    "none",
    "-p",
    String(target.port),
    "-l",
    target.username,
    ...(key ? ["-i", target.identityFile] : []),
    ...[
      // Prompts (key passphrase or password) are answered only by askpass.
      `BatchMode=${target.askpassFile ? "no" : "yes"}`,
      "IdentitiesOnly=yes",
      "IdentityAgent=none",
      ...(key
        ? [
            "PubkeyAuthentication=yes",
            "PasswordAuthentication=no",
            "KbdInteractiveAuthentication=no",
            "PreferredAuthentications=publickey",
          ]
        : [
            "PubkeyAuthentication=no",
            "PasswordAuthentication=yes",
            "KbdInteractiveAuthentication=yes",
            "PreferredAuthentications=keyboard-interactive,password",
          ]),
      "NumberOfPasswordPrompts=1",
      "StrictHostKeyChecking=yes",
      `UserKnownHostsFile=${target.knownHostsFile}`,
      "GlobalKnownHostsFile=/dev/null",
      ...(target.hostKeyAlias ? [`HostKeyAlias=${target.hostKeyAlias}`] : []),
      "UpdateHostKeys=no",
      "ForwardAgent=no",
      "ClearAllForwardings=yes",
      "PermitLocalCommand=no",
      "ControlMaster=no",
      "ControlPath=none",
      "ProxyCommand=none",
      "ProxyJump=none",
      "CanonicalizeHostname=no",
      "ConnectTimeout=10",
      "ServerAliveInterval=15",
      "ServerAliveCountMax=2",
    ].flatMap((value) => ["-o", value]),
    "--",
    target.host,
    remoteCommand,
  ];
}

export function sshTerminalSpec(raw, cwd = ".") {
  const target = validateSshTarget(raw);
  if (
    typeof cwd !== "string" ||
    cwd.startsWith("/") ||
    /[^\x20-\uFFFF]|[\x7f\\]/.test(cwd) ||
    cwd.split("/").includes("..")
  )
    throw new Error("Invalid SSH terminal cwd.");
  const directory = path.posix.join(target.root, cwd);
  return {
    command: "/usr/bin/ssh",
    args: sshArguments(
      target,
      `cd ${quote(directory)} && exec /bin/sh -l`,
      true,
    ),
  };
}

export function createSshSandbox(raw, identity = {}) {
  const target = validateSshTarget(raw);
  const active = new Set();
  for (const [filename, secret] of [
    [target.identityFile, true],
    [target.knownHostsFile, false],
    [target.askpassFile, true],
  ]) {
    if (filename === undefined) continue;
    const info = statSync(filename);
    if (!info.isFile() || info.mode & (secret ? 0o077 : 0o022))
      throw new Error("SSH credential files have unsafe permissions.");
  }
  const localEnv = sshEnvironment(target);

  async function request(tool, args = {}, env = {}) {
    if (!TOOLS.has(tool)) throw new Error("Unknown SSH sandbox tool.");
    const timeout =
      tool === "shell_exec" || tool === "process_exec"
        ? (args.timeoutMs ?? 30000)
        : 30000;
    if (
      typeof timeout !== "number" ||
      !Number.isFinite(timeout) ||
      timeout < 1 ||
      timeout > 120000
    )
      throw new Error("Invalid SSH timeout.");
    const body = `${JSON.stringify({ root: target.root, tool, args, env })}\n`;
    if (Buffer.byteLength(body) > 4_000_000)
      throw new Error("SSH request exceeds limit.");
    if (active.size >= 4) throw new Error("SSH sandbox is busy.");
    return new Promise((resolve, reject) => {
      const child = spawn(
        "/usr/bin/ssh",
        sshArguments(target, `/usr/bin/python3 -u -c ${quote(workerSource())}`),
        {
          shell: false,
          env: localEnv,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      active.add(child);
      let settled = false;
      let size = 0;
      const chunks = [];
      const fail = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.stdin.destroy();
        child.kill("SIGKILL");
        reject(
          new Error(
            "SSH sandbox unavailable; verify the pinned host key, identity, remote Python and root directory.",
          ),
        );
      };
      // Remote timeout owns process cleanup; this is a transport backstop.
      const timer = setTimeout(fail, timeout + 15000);
      child.on("error", fail);
      child.stdin.on("error", fail);
      child.stderr.resume(); // Never forward OpenSSH diagnostics containing paths.
      child.stdout.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_RESPONSE) fail();
        else chunks.push(chunk);
      });
      child.on("close", (code) => {
        active.delete(child);
        if (settled) return;
        if (code !== 0) return fail();
        try {
          const response = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (
            !response.ok ||
            !response.result ||
            typeof response.result !== "object"
          )
            return fail();
          settled = true;
          clearTimeout(timer);
          resolve(response);
        } catch {
          fail();
        }
      });
      // Keep stdin open. EOF is the worker's disconnect/cancellation signal.
      child.stdin.write(body);
    });
  }
  return {
    async ready() {
      await request("sandbox_info");
    },
    async callTool(tool, args, env) {
      if (!TOOLS.has(tool)) return null;
      try {
        const response = await request(tool, args, env);
        const result =
          tool === "sandbox_info"
            ? { ...response.result, ...identity }
            : response.result;
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          isError: response.isError === true,
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: error.message }],
          isError: true,
        };
      }
    },
    terminal(cwd) {
      return { ...sshTerminalSpec(target, cwd), env: localEnv };
    },
    close() {
      for (const child of active) {
        child.stdin.destroy();
        child.kill("SIGKILL");
      }
      active.clear();
    },
  };
}
