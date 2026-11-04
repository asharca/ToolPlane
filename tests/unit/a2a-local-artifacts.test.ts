// @vitest-environment node
import { describe, expect, it } from "vitest";
import { Artifact } from "@a2a-js/sdk";
import { parseLocalArtifact } from "@/lib/a2a/local-artifacts";
import { artifactDigest, stampArtifactProvenance } from "@/lib/a2a/model";
const input = (part: unknown, name = "report.txt") => ({
  artifactId: "report-1",
  name,
  parts: [part],
});
describe("bounded standard A2A Artifact validation", () => {
  it("uses the configured inline limit independently of the bounded text/JSON artifact payload", () => {
    const policy = { allowHttp: false, a2aInlineBytes: 512 * 1024 };
    const raw = Buffer.alloc(policy.a2aInlineBytes, 97).toString("base64");
    expect(
      parseLocalArtifact(
        input({ raw, mediaType: "application/octet-stream" }),
        policy,
      ).parts[0].content?.$case,
    ).toBe("raw");
    expect(() =>
      parseLocalArtifact(input({ raw, mediaType: "application/octet-stream" })),
    ).toThrow();
    expect(() =>
      parseLocalArtifact(
        input({
          raw: Buffer.alloc(policy.a2aInlineBytes + 1).toString("base64"),
          mediaType: "application/octet-stream",
        }),
        policy,
      ),
    ).toThrow();
  });
  it("stamps stable canonical content integrity without changing replay identity", () => {
    const artifact = parseLocalArtifact(input({ data: { z: 1, a: "中" } }));
    const identity = artifactDigest(artifact);
    const source = {
      taskId: "task",
      contextId: "context",
      targetId: "agent",
      targetKind: "local" as const,
    };
    stampArtifactProvenance(artifact, source);
    const provenance = artifact.metadata?.["toolplane.dev/provenance"];
    expect(provenance).toMatchObject({
      ...source,
      sizeBytes: Buffer.byteLength(JSON.stringify({ a: "中", z: 1 })),
      digest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(artifactDigest(artifact)).toBe(identity);
    const same = stampArtifactProvenance(
      parseLocalArtifact(input({ data: { a: "中", z: 1 } })),
      source,
    );
    expect(same.metadata?.["toolplane.dev/provenance"]).toEqual(provenance);
    const changed = stampArtifactProvenance(
      parseLocalArtifact(input({ data: { a: "changed", z: 1 } })),
      source,
    );
    expect(changed.metadata?.["toolplane.dev/provenance"]).not.toEqual(
      provenance,
    );
  });
  it("uses official data/raw/text Part encodings", () => {
    expect(
      Artifact.toJSON(parseLocalArtifact(input({ data: { ok: true } }))),
    ).toMatchObject({
      parts: [{ data: { ok: true }, mediaType: "application/json" }],
    });
    expect(
      Artifact.toJSON(
        parseLocalArtifact(
          input({ raw: "aGVsbG8=", mediaType: "application/octet-stream" }),
        ),
      ),
    ).toMatchObject({ parts: [{ raw: "aGVsbG8=" }] });
  });
  it.each([
    { url: "http://169.254.169.254/latest/meta-data" },
    { file: { uri: "/etc/passwd" } },
    { text: "x", data: {} },
    { raw: "invalid!", mediaType: "text/plain" },
    { raw: "Zh==", mediaType: "text/plain" },
    { raw: "Zg==" },
    { data: { toolplaneFileId: "foreign" }, mediaType: "application/json" },
    { text: "spoofed", metadata: { toolplaneFileId: "foreign" } },
    { path: "/workspace/report.txt" },
    { fileId: "unresolved" },
  ])("rejects unsafe or noncanonical content %j", (part) => {
    expect(() => parseLocalArtifact(input(part))).toThrow();
  });
  it.each(["../private", "/etc/passwd", "a\\b", "name\r\n"])(
    "rejects path/header-like names %j",
    (name) => {
      expect(() =>
        parseLocalArtifact(input({ text: "hello" }, name)),
      ).toThrow();
    },
  );
  it("counts UTF-8 bytes and decoded file sizes, not just code units", () => {
    expect(() =>
      parseLocalArtifact(input({ text: "中".repeat(12000) })),
    ).toThrow();
    expect(() =>
      parseLocalArtifact(
        input({
          raw: Buffer.alloc(32769).toString("base64"),
          mediaType: "application/octet-stream",
        }),
      ),
    ).toThrow();
  });
});
