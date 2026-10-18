// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  listSshTargetsForWorkspace,
  resolveSshTargetForWorkspace,
  sshTargetIdFromConfig,
} from "@/lib/sandboxes/ssh-targets";

let directory: string;
let filename: string;
const target = {
  id: "approved",
  name: " Approved host ",
  workspaceIds: ["workspace-1"],
  host: "host.test",
  username: "runner",
  root: "/srv/workspace",
  identityFile: "/keys/id_ed25519",
  knownHostsFile: "/keys/known_hosts",
};
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "ssh-target-boundaries-"));
  filename = join(directory, "targets.json");
  vi.stubEnv("TOOLPLANE_SSH_TARGETS_FILE", filename);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

describe("approved SSH target boundaries", () => {
  it("lists only public labels for the authorized workspace and resolves private details separately", () => {
    writeFileSync(
      filename,
      JSON.stringify([
        target,
        { ...target, id: "other", workspaceIds: ["workspace-2"] },
      ]),
    );
    expect(listSshTargetsForWorkspace("workspace-1")).toEqual([
      { id: "approved", name: "Approved host" },
    ]);
    expect(listSshTargetsForWorkspace("outsider")).toEqual([]);
    expect(resolveSshTargetForWorkspace("approved", "workspace-1")).toEqual({
      host: "host.test",
      port: 22,
      username: "runner",
      root: "/srv/workspace",
      identityFile: "/keys/id_ed25519",
      knownHostsFile: "/keys/known_hosts",
    });
    expect(() => resolveSshTargetForWorkspace("approved", "outsider")).toThrow(
      "not authorized",
    );
  });
  it("disables SSH when no administrator target file is configured", () => {
    vi.stubEnv("TOOLPLANE_SSH_TARGETS_FILE", "");
    expect(listSshTargetsForWorkspace("workspace-1")).toEqual([]);
    expect(() =>
      resolveSshTargetForWorkspace("approved", "workspace-1"),
    ).toThrow("not authorized");
  });
  it.each([
    { root: "/srv/../etc" },
    { root: "relative/path" },
    { identityFile: "/keys/private key" },
    { knownHostsFile: "/keys/../known_hosts" },
    { host: "host;whoami" },
    { username: "-root" },
    { port: 0 },
    { port: 65536 },
    { workspaceIds: [] },
    { extra: "not allowed" },
  ])("fails closed for invalid administrator configuration %j", (override) => {
    writeFileSync(filename, JSON.stringify([{ ...target, ...override }]));
    expect(() => listSshTargetsForWorkspace("workspace-1")).toThrow(
      "configuration is unavailable or invalid",
    );
  });
  it.each([
    "not-json",
    JSON.stringify([target, target]),
    " ".repeat(1_000_001),
  ])("rejects corrupt, duplicated or oversized target files", (text) => {
    writeFileSync(filename, text);
    expect(() => listSshTargetsForWorkspace("workspace-1")).toThrow(
      "configuration is unavailable or invalid",
    );
  });
  it("fails closed when the target file cannot be read", () => {
    expect(() => listSshTargetsForWorkspace("workspace-1")).toThrow(
      "configuration is unavailable or invalid",
    );
  });
  it.each([
    null,
    [],
    "approved",
    {},
    { sshTargetId: "../escape" },
    { sshTargetId: 42 },
    { sshTargetId: "" },
  ])("rejects untrusted target references %j", (config) => {
    expect(sshTargetIdFromConfig(config)).toBeNull();
  });
  it("accepts a scoped identifier but never interprets host overrides", () => {
    expect(
      sshTargetIdFromConfig({
        sshTargetId: "approved-target_1",
        host: "attacker.test",
      }),
    ).toBe("approved-target_1");
  });
});
