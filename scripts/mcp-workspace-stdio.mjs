import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { posix } from "node:path";
import {
  expandMcpArguments,
  SECRET_ENV_BOOTSTRAP,
  secretEnvironmentLine,
} from "./mcp-secret-bootstrap.mjs";
import { sshArguments, sshEnvironment } from "./ssh-sandbox-adapter.mjs";

// An exec client disappearing is not a signal to a process inside the sandbox.
// Keep the transport's stdin separate from the program's stdin. EOF owns the
// process group even for a server that ignores EOF, SIGTERM, or has children.
const track = `
set -eu
dir=$(mktemp -d); mkfifo "$dir/in"
setsid sh -ec '${SECRET_ENV_BOOTSTRAP}' toolplane-mcp <"$dir/in" & pid=$!
exec 3<&0
(cat <&3 >"$dir/in"; kill -KILL "-$pid" 2>/dev/null || :) & relay=$!
trap 'kill -KILL "-$pid" "$relay" 2>/dev/null || :; rm -rf "$dir"' EXIT
wait "$pid"
`;
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;

export function spawnWorkspaceProcess(target, command, args, env, cliEnv) {
  const argv = [command, ...expandMcpArguments(args, env)];
  if (target.kind === "connector") {
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("./mcp-connector-stdio.mjs", import.meta.url))],
      { env: {}, stdio: "pipe" },
    );
    child.stdin.write(
      `${JSON.stringify({
        url: target.url,
        token: target.token,
        cwd: posix.relative("/workspace", target.cwd) || ".",
        argv,
        env,
      })}\n`,
    );
    return child;
  }
  let child;
  if (target.kind === "docker") {
    child = spawn(
      "docker",
      [
        "exec",
        "-i",
        ...(target.cwd ? ["--workdir", target.cwd] : []),
        target.container,
        "sh",
        "-c",
        track,
      ],
      { env: cliEnv, stdio: "pipe" },
    );
  } else if (target.kind === "ssh") {
    const worker = readFileSync(
      new URL("./mcp-ssh-stdio.py", import.meta.url),
      "utf8",
    );
    const cwd = posix.relative("/workspace", target.cwd) || ".";
    child = spawn(
      "/usr/bin/ssh",
      sshArguments(target.ssh, `/usr/bin/python3 -u -c ${quote(worker)}`),
      { env: sshEnvironment(target.ssh), stdio: "pipe" },
    );
    child.stdin.write(
      `${JSON.stringify({ root: target.ssh.root, cwd, argv, env })}\n`,
    );
    return child;
  } else throw new Error("sandboxUnavailable");
  child.stdin.write(secretEnvironmentLine(env, argv));
  return child;
}
