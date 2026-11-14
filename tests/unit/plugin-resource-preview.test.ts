import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  PiPackageSnapshotV1,
  PiPackageEntryV1,
} from "@/lib/pi-packages/manifest";
import {
  previewPluginResource,
  RESOURCE_PREVIEW_MAX_BYTES,
} from "@/lib/plugins/resource-preview";

const path = "package/skills/review/SKILL.md";
function file(name: string, bytes: Buffer): PiPackageEntryV1 {
  return {
    type: "file",
    path: name,
    contentEncoding: "base64",
    content: bytes.toString("base64"),
    executable: false,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
function snapshot(
  entries: PiPackageEntryV1[],
  paths = [path],
): PiPackageSnapshotV1 {
  return {
    source: {
      kind: "toolplane",
      requested: "toolplane:review@1.0.0",
      name: "review",
      version: "1.0.0",
    },
    name: "review",
    version: "1.0.0",
    root: "package",
    runtime: {
      kind: "pi-sdk",
      piVersion: "1.5.2",
      nodeMajor: 26,
      platform: "any",
      arch: "any",
    },
    resources: { skills: paths, extensions: [], prompts: [], themes: [] },
    entries,
  };
}

describe("immutable snapshot resource preview boundary", () => {
  it("reads exact declared paths from the selected snapshot, not another release", () => {
    const old = snapshot([file(path, Buffer.from("old instructions"))]);
    const current = snapshot([file(path, Buffer.from("new instructions"))]);
    expect(previewPluginResource(old, path)).toMatchObject({
      status: "ready",
      text: "old instructions",
      markdown: true,
    });
    expect(previewPluginResource(current, path)).toMatchObject({
      status: "ready",
      text: "new instructions",
    });
  });
  it("rejects traversal, encoded aliases and undeclared files even when entries exist", () => {
    const value = snapshot([
      file(path, Buffer.from("safe")),
      file("package/secret.txt", Buffer.from("secret")),
    ]);
    for (const request of [
      "/etc/passwd",
      "package/../secret",
      "package/%2e%2e/secret",
      "package/secret.txt",
      path.toUpperCase(),
      `${path}%00`,
    ])
      expect(previewPluginResource(value, request).status).toBe("notAllowed");
    expect(
      previewPluginResource(
        snapshot([], ["package/../secret"]),
        "package/../secret",
      ).status,
    ).toBe("notAllowed");
  });
  it("never follows declared symbolic links", () => {
    const value = snapshot([
      { type: "symlink", path, target: "../../secret.txt" },
      file("package/secret.txt", Buffer.from("secret")),
    ]);
    expect(previewPluginResource(value, path).status).toBe("symlink");
  });
  it("distinguishes missing, directory, empty, binary, invalid UTF-8 and oversized content", () => {
    expect(previewPluginResource(snapshot([]), path).status).toBe("missing");
    expect(
      previewPluginResource(snapshot([{ type: "directory", path }]), path)
        .status,
    ).toBe("notFile");
    for (const [bytes, status] of [
      [Buffer.from(" \n"), "empty"],
      [Buffer.from([0, 1]), "binary"],
      [Buffer.from([0xff]), "invalidUtf8"],
      [Buffer.alloc(RESOURCE_PREVIEW_MAX_BYTES + 1, 65), "tooLarge"],
      [Buffer.alloc(RESOURCE_PREVIEW_MAX_BYTES, 65), "ready"],
    ] as const)
      expect(
        previewPluginResource(snapshot([file(path, bytes)]), path).status,
      ).toBe(status);
  });
});
