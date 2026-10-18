// @vitest-environment node
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  decryptSecretText: vi.fn(),
  findMany: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("@/lib/db", () => ({
  db: { deploymentConfigFile: { findMany: mocks.findMany } },
}));
vi.mock("@/lib/security/secrets", () => ({
  decryptSecretText: mocks.decryptSecretText,
}));

import { materializeDeploymentConfigVolume } from "@/lib/process/deployment-config-volume";

function child({
  archive,
  input,
  command = "docker",
}: {
  archive?: Buffer;
  input?: (value: Buffer) => void;
  command?: "docker" | "tar";
} = {}) {
  const stdin = input
    ? Object.assign(new EventEmitter(), { end: vi.fn(input) })
    : null;
  const result = Object.assign(new EventEmitter(), {
    kill: vi.fn(),
    stderr: new EventEmitter(),
    stdin,
    stdout: new EventEmitter(),
  });
  queueMicrotask(() => {
    if (archive) result.stdout.emit("data", archive);
    result.emit(command === "tar" ? "close" : "exit", 0, null);
  });
  return result;
}

describe("deployment configuration volume materialization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("streams the staged archive to a one-shot read-only Docker helper", async () => {
    const content = '{"host":"switch"}\n';
    const archive = Buffer.from("tar archive");
    const inputs: Buffer[] = [];
    mocks.findMany.mockResolvedValue([
      {
        id: "file-1",
        path: "ssh-config.json",
        encryptedContent: { ciphertext: "ignored" },
        size: Buffer.byteLength(content),
      },
    ]);
    mocks.decryptSecretText.mockReturnValue(content);
    mocks.spawn.mockImplementation((command: string, args: string[]) => {
      if (command === "tar") return child({ archive, command: "tar" });
      if (command === "docker" && args[0] === "run") {
        return child({ input: (value) => inputs.push(value) });
      }
      if (command === "docker" && args[0] === "volume") return child();
      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    });

    const result = await materializeDeploymentConfigVolume("deployment-1");
    expect(result.hasFiles).toBe(true);
    expect(result.redactionValues).toContain(content);

    const calls = mocks.spawn.mock.calls.map(([command, args]) => ({
      command,
      args: args as string[],
    }));
    expect(calls[0]).toMatchObject({
      command: "tar",
      args: expect.arrayContaining(["-cf", "-", "."]),
    });
    expect(calls[1]).toEqual({
      command: "docker",
      args: ["volume", "create", "toolplane_mcp_config_deployment-1"],
    });
    expect(calls[2]).toMatchObject({
      command: "docker",
      args: expect.arrayContaining(["run", "--rm", "-i", "--read-only"]),
    });
    expect(calls).toHaveLength(3);
    expect(
      calls
        .filter(({ command }) => command === "docker")
        .map(({ args }) => args[0]),
    ).toEqual(["volume", "run"]);
    expect(inputs).toEqual([archive]);
  });
  it("removes stale configuration when the final file was deleted", async () => {
    mocks.findMany.mockResolvedValue([]);
    mocks.spawn.mockImplementation(() => child());
    await expect(
      materializeDeploymentConfigVolume("deployment-empty"),
    ).resolves.toEqual({ hasFiles: false, redactionValues: [] });
    expect(mocks.spawn).toHaveBeenCalledWith(
      "docker",
      ["volume", "rm", "-f", "toolplane_mcp_config_deployment-empty"],
      expect.any(Object),
    );
    expect(mocks.decryptSecretText).not.toHaveBeenCalled();
  });

  it.each([
    ["../escape", "text", 4, "unsafe file path"],
    ["config", "before\0after", 12, "not valid text"],
    ["config", "text", -1, "size does not match"],
    ["config", "text", 4.5, "size does not match"],
    ["config", "密码", 2, "size does not match"],
    [
      "config",
      "x".repeat(512 * 1024 + 1),
      512 * 1024 + 1,
      "exceeds 524288 bytes",
    ],
  ])(
    "rejects invalid decrypted files before creating resources",
    async (path, content, size, message) => {
      mocks.findMany.mockResolvedValue([
        { id: "file", path, encryptedContent: {}, size },
      ]);
      mocks.decryptSecretText.mockReturnValue(content);
      await expect(
        materializeDeploymentConfigVolume("deployment-invalid"),
      ).rejects.toThrow(message);
      expect(mocks.spawn).not.toHaveBeenCalled();
    },
  );

  it("rejects portable path collisions", async () => {
    mocks.findMany.mockResolvedValue(
      ["Config.json", "config.json"].map((path) => ({
        id: path,
        path,
        encryptedContent: {},
        size: 4,
      })),
    );
    mocks.decryptSecretText.mockReturnValue("text");
    await expect(
      materializeDeploymentConfigVolume("deployment-invalid"),
    ).rejects.toThrow("duplicate file path");
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it.each([33, 5])(
    "rejects excessive file counts or total bytes (%s files)",
    async (count) => {
      const content = "x".repeat(512 * 1024);
      mocks.findMany.mockResolvedValue(
        Array.from({ length: count }, (_, index) => ({
          id: String(index),
          path: `config-${index}`,
          encryptedContent: {},
          size: content.length,
        })),
      );
      mocks.decryptSecretText.mockReturnValue(content);
      await expect(
        materializeDeploymentConfigVolume("deployment-invalid"),
      ).rejects.toThrow(count === 33 ? "exceeds 32 files" : "bytes in total");
      expect(mocks.spawn).not.toHaveBeenCalled();
    },
  );

  it("propagates decryption failures before creating resources", async () => {
    mocks.findMany.mockResolvedValue([
      { id: "file", path: "config", encryptedContent: {}, size: 4 },
    ]);
    mocks.decryptSecretText.mockImplementation(() => {
      throw new Error("ciphertext authentication failed");
    });
    await expect(
      materializeDeploymentConfigVolume("deployment-invalid"),
    ).rejects.toThrow("ciphertext authentication failed");
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});
