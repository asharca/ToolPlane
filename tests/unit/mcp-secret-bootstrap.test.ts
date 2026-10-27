import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  SECRET_ENV_BOOTSTRAP,
  secretEnvironmentLine,
  withSecretEnvironmentBootstrap,
} from "../../scripts/mcp-secret-bootstrap.mjs";

describe("MCP runtime-only credential delivery", () => {
  it("preserves multiline Unicode values and following MCP bytes without shell expansion", () => {
    const value = "秘密 ' $(exit 9) `exit 8` \\ \r\ntrailing\n\n";
    const line = secretEnvironmentLine({
      TOKEN: value,
      EMPTY: "",
      toolplane_env: "retained",
    });
    const protocol = '{"jsonrpc":"2.0","id":1}\n';
    const result = spawnSync(
      "/bin/sh",
      [
        "-ec",
        SECRET_ENV_BOOTSTRAP,
        "toolplane-mcp",
        process.execPath,
        "-e",
        "let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>process.stdout.write(JSON.stringify({token:process.env.TOKEN,empty:process.env.EMPTY,own:process.env.toolplane_env,input})))",
      ],
      { input: line + protocol, encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      token: value,
      empty: "",
      own: "retained",
      input: protocol,
    });
    expect(line.split("\n")).toHaveLength(2);
    expect(line).not.toContain(value);
  });

  it("preserves image entrypoint/default command without putting credentials in Docker metadata", () => {
    const args = withSecretEnvironmentBootstrap(
      ["run", "--read-only", "--network", "none", "image"],
      "image",
      { Entrypoint: ["/server"], Cmd: ["--stdio"] },
    );
    expect(args).toEqual([
      "run",
      "--read-only",
      "--network",
      "none",
      "--entrypoint",
      "/bin/sh",
      "image",
      "-ec",
      SECRET_ENV_BOOTSTRAP,
      "toolplane-mcp",
      "/server",
      "--stdio",
    ]);
    expect(args).not.toContain("-e");
    expect(args).not.toContain("--env");
  });

  it("preserves configured arguments and entrypoint overrides", () => {
    const args = withSecretEnvironmentBootstrap(
      ["run", "--entrypoint", "/override", "image", "--custom"],
      "image",
      { Entrypoint: ["/server"], Cmd: ["--default"] },
    );
    expect(args.slice(-2)).toEqual(["/override", "--custom"]);
    expect(args).not.toContain("/server");
    expect(args).not.toContain("--default");
  });

  it("clears image CMD on an entrypoint override and disables a second tag pull", () => {
    const args = withSecretEnvironmentBootstrap(
      ["run", "--pull", "always", "--entrypoint=/override", "image"],
      "image",
      { Entrypoint: ["/server"], Cmd: ["--default"] },
    );
    expect(args.slice(-1)).toEqual(["/override"]);
    expect(args.slice(1, 3)).toEqual(["--pull", "never"]);
    expect(args).not.toContain("--default");
  });

  it.each([
    "-e",
    "--env",
    "--env-file",
    "--env=TOKEN=secret",
    "-eTOKEN=secret",
  ])("rejects Docker environment transport %s", (flag) => {
    expect(() =>
      withSecretEnvironmentBootstrap(
        ["run", flag, "TOKEN=secret", "image"],
        "image",
        { Entrypoint: ["/server"] },
      ),
    ).toThrow("Docker environment flags are forbidden");
  });

  it("rejects invalid keys and NUL without echoing values", () => {
    expect(() => secretEnvironmentLine({ "bad-key": "private-value" })).toThrow(
      "Invalid MCP runtime environment",
    );
    expect(() => secretEnvironmentLine({ TOKEN: "private\0value" })).toThrow(
      "Invalid MCP runtime environment",
    );
  });
});
