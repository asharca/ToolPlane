import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { sandboxFlags, envFlags, MCP_NETWORK } from "@/lib/process/sandbox";
import {
  DEFAULT_SANDBOX_IMAGE,
  SANDBOX_IMAGE_OPTIONS,
  resolveSandboxImage,
} from "@/lib/sandboxes/images";
import { parseSandboxDirectoryText } from "@/lib/sandboxes/file-list";
import {
  parseSandboxEnvText,
  readSandboxAllowSudo,
  readSandboxEnv,
  sandboxConfigWithAllowSudo,
  sandboxEnvToText,
} from "@/lib/sandboxes/env";
import {
  dockerVolumeCopyArgs,
  sandboxSnapshotVolumeName,
} from "@/lib/sandboxes/runtime";

describe("sandboxFlags", () => {
  it("isolated: hardening flags + the dedicated sandbox network", () => {
    const f = sandboxFlags("isolated");
    expect(f).toEqual(
      expect.arrayContaining([
        "--rm",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--read-only",
        "--network",
        MCP_NETWORK,
      ]),
    );
    expect(f).toContain("--memory");
    expect(f).toContain("--pids-limit");
    expect(f).toContain("--cpus");
  });

  it("none: full network isolation", () => {
    expect(sandboxFlags("none")).toContain("none");
    expect(sandboxFlags("none")).not.toContain(MCP_NETWORK);
  });
});

describe("envFlags", () => {
  it("maps to value-free Docker env flags", () => {
    expect(envFlags({ A: "1", B: "2" })).toEqual(["-e", "A", "-e", "B"]);
  });
  it("empty for no env", () => {
    expect(envFlags({})).toEqual([]);
  });
});

describe("sandbox env config", () => {
  it("parses KEY=value lines, comments, and empty lines", () => {
    expect(parseSandboxEnvText("A=1\n# comment\n\nB=two=parts")).toEqual({
      A: "1",
      B: "two=parts",
    });
  });

  it("round-trips stored env as sorted text", () => {
    const env = readSandboxEnv({
      env: { ZED: "last", A: "first", "invalid-key": "nope", N: 42 },
    });

    expect(env).toEqual({ A: "first", ZED: "last" });
    expect(sandboxEnvToText(env)).toBe("A=first\nZED=last");
  });

  it("treats a missing sudo setting as disabled and toggles other keys intact", () => {
    expect(readSandboxAllowSudo(null)).toBe(false);
    expect(readSandboxAllowSudo({ allowSudo: "true" })).toBe(false);
    expect(readSandboxAllowSudo({ allowSudo: true })).toBe(true);

    const enabled = sandboxConfigWithAllowSudo(
      { managedBy: "agent-runtime" },
      true,
    );
    expect(enabled).toEqual({ managedBy: "agent-runtime", allowSudo: true });
    expect(sandboxConfigWithAllowSudo(enabled, false)).toEqual({
      managedBy: "agent-runtime",
    });
    expect(sandboxConfigWithAllowSudo(null, true)).toEqual({ allowSudo: true });
  });
});

describe("persistent Docker sandbox runtime", () => {
  it("keeps the interactive Hermes terminal wrapper valid Bash", () => {
    const source = readFileSync(
      path.join(process.cwd(), "scripts/sandbox-mcp-server.mjs"),
      "utf8",
    );
    const wrapper =
      /const HERMES_TERMINAL_SHELL = String\.raw`([\s\S]*?)`\.trim\(\);/.exec(
        source,
      )?.[1];
    expect(wrapper).toBeTruthy();

    const parsed = spawnSync("bash", ["-n"], {
      input: wrapper,
      encoding: "utf8",
    });
    expect(parsed.status, parsed.stderr).toBe(0);
  });
});

describe("Docker sandbox volume snapshots", () => {
  it("builds a least-privilege, non-networked volume copy command", () => {
    const args = dockerVolumeCopyArgs("source-volume", "destination.volume");
    const script = args.at(-1);

    expect(args).toEqual(
      expect.arrayContaining([
        "--rm",
        "--read-only",
        "--network",
        "none",
        "--memory",
        "512m",
        "--cpus",
        "1",
        "--pids-limit",
        "128",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "type=volume,src=source-volume,dst=/from,readonly",
        "type=volume,src=destination.volume,dst=/to",
      ]),
    );
    expect(args).not.toContain("--privileged");
    expect(args.filter((arg) => arg === "--cap-add")).toHaveLength(3);
    expect(script).toBe(
      'set -euo pipefail; test -z "$(find /to -mindepth 1 -print -quit)"; ' +
        "tar -C /from -cf - . | tar -C /to -xpf -",
    );
    expect(script).not.toContain("source-volume");
    expect(script).not.toContain("destination.volume");
  });

  it("uses an explicit destination reset only for snapshot restore", () => {
    const args = dockerVolumeCopyArgs(
      "snapshot-volume",
      "sandbox-volume",
      true,
    );

    expect(args.at(-1)).toContain("rm -rf /to/* /to/.[!.]* /to/..?*");
    expect(args.at(-1)).not.toContain("find /to -mindepth 1");
  });

  it("can name and label a copy helper so timeout cleanup can target it", () => {
    const args = dockerVolumeCopyArgs(
      "source-volume",
      "destination-volume",
      false,
      "toolplane-volume-copy-test",
    );

    expect(args).toEqual(
      expect.arrayContaining([
        "--name",
        "toolplane-volume-copy-test",
        "--label",
        "toolplane.volume-copy=true",
      ]),
    );
    expect(() =>
      dockerVolumeCopyArgs(
        "source-volume",
        "destination-volume",
        false,
        "invalid helper",
      ),
    ).toThrow();
  });

  it("rejects shell-like volume names and same-volume copies", () => {
    for (const invalid of [
      "volume;touch-pwned",
      "volume$(touch-pwned)",
      "volume name",
      "--volume",
      "volume/path",
    ]) {
      expect(() => dockerVolumeCopyArgs("source-volume", invalid)).toThrow();
    }
    expect(() => dockerVolumeCopyArgs("same-volume", "same-volume")).toThrow();
  });

  it("sanitizes snapshot identifiers before deriving Docker volume names", () => {
    const volumeName = sandboxSnapshotVolumeName(
      "snapshot/../../$(touch pwned)",
    );

    expect(volumeName).toMatch(/^toolplane_snapshot_[a-zA-Z0-9_.-]+$/);
    expect(volumeName).not.toContain("/");
    expect(volumeName).not.toContain("$");
    expect(volumeName).not.toContain(" ");
  });
});

describe("sandbox image catalog", () => {
  it("includes the default Dev Container image and common language stacks", () => {
    expect(SANDBOX_IMAGE_OPTIONS[0].image).toBe(DEFAULT_SANDBOX_IMAGE);
    expect(SANDBOX_IMAGE_OPTIONS.map((option) => option.image)).toEqual(
      expect.arrayContaining([
        "mcr.microsoft.com/devcontainers/typescript-node:24-bookworm",
        "mcr.microsoft.com/devcontainers/python:3.12-bookworm",
        "mcr.microsoft.com/devcontainers/go:1-bookworm",
        "mcr.microsoft.com/devcontainers/rust:1-bookworm",
        "mcr.microsoft.com/devcontainers/universal:2",
      ]),
    );
  });

  it("resolves preset, custom, and empty image choices", () => {
    expect(resolveSandboxImage("python-312", "")).toBe(
      "mcr.microsoft.com/devcontainers/python:3.12-bookworm",
    );
    expect(resolveSandboxImage("custom", "ghcr.io/acme/sandbox:latest")).toBe(
      "ghcr.io/acme/sandbox:latest",
    );
    expect(resolveSandboxImage("", "")).toBe(DEFAULT_SANDBOX_IMAGE);
  });
});

describe("parseSandboxDirectoryText", () => {
  it("uses the requested path for legacy ls output without a path field", () => {
    const listing = parseSandboxDirectoryText(
      JSON.stringify({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "total 4\n-rw-r--r-- 1 root root 46 Jul 4 14:01 sample.csv\n",
        stderr: "",
      }),
      "data",
    );

    expect(listing).toEqual({
      path: "data",
      entries: [{ name: "sample.csv", type: "file", size: 46 }],
    });
  });
});
