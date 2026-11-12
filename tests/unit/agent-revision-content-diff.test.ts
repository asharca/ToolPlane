import { applyPatch } from "diff";
import { describe, expect, it } from "vitest";
import { buildAgentRevisionDiff } from "@/lib/revisions/config-diff";
import type { AgentRevisionConfig } from "@/lib/agents/revision-types";

const config: AgentRevisionConfig = {
  schemaVersion: 1,
  runtimeKind: "pi-sdk",
  systemPrompt: "original\n",
  providerId: null,
  model: null,
  modelProviderIds: [],
  maxSteps: 10,
  disabledBuiltinTools: [],
  sandboxTemplateId: null,
  externalSandboxes: [],
  environment: {
    kind: "docker",
    image: `fixture@sha256:${"a".repeat(64)}`,
    network: "isolated",
    piVersion: "0.87.1",
    initialSnapshot: null,
    resourceLimits: { memoryBytes: 536870912, cpus: 1, pidsLimit: 128 },
    credentialReferences: [],
  },
  skills: [],
  knowledgeBaseIds: [],
  packages: [],
  mcpGrants: [],
  a2a: {
    inboundEnabled: false,
    outboundEnabled: false,
    policy: { schemaVersion: 1, targets: [] },
  },
};

describe("revision review exact content", () => {
  it.each([
    ["old\nkeep\n", "new\nkeep\n"],
    ["old", "new"],
    ["same", "same\n"],
    ["", "新增\n第二行"],
    ["removed\n", ""],
    ["alpha\r\nbeta\r\n", "alpha\r\ngamma\r\n"],
  ])(
    "exports a patch that reconstructs the reviewed prompt %#",
    (before, after) => {
      const result = buildAgentRevisionDiff(
        { ...config, systemPrompt: before },
        { ...config, systemPrompt: after },
      );
      const file = result.files.find(
        (entry) => entry.path === "systemPrompt.md",
      );
      expect(file).toBeDefined();
      if (!file) throw new Error("Missing prompt diff");
      expect(applyPatch(before, file.patch)).toBe(after);
      expect(
        file.lines
          .filter((line) => line.type !== "added")
          .map((line) => line.oldLine),
      ).toEqual(
        Array.from(
          { length: file.lines.filter((line) => line.type !== "added").length },
          (_, index) => index + 1,
        ),
      );
    },
  );

  it("does not report changes for JSON key reordering", () => {
    const reordered = {
      ...config,
      environment: {
        ...config.environment,
        resourceLimits: { pidsLimit: 128, cpus: 1, memoryBytes: 536870912 },
      },
    };
    expect(buildAgentRevisionDiff(config, reordered).files).toEqual([]);
  });

  it("preserves exact replacement when a large change exceeds the search bound", () => {
    const before = Array.from({ length: 1100 }, (_, i) => `before-${i}\n`).join(
      "",
    );
    const after = Array.from({ length: 1100 }, (_, i) => `after-${i}\n`).join(
      "",
    );
    const result = buildAgentRevisionDiff(
      { ...config, systemPrompt: before },
      { ...config, systemPrompt: after },
    );
    expect(applyPatch(before, result.files[0].patch)).toBe(after);
    expect(result.additions).toBe(1100);
    expect(result.deletions).toBe(1100);
  });

  it("keeps a binary attachment distinct from an actual .binary.json text file", () => {
    const after: AgentRevisionConfig = {
      ...config,
      skills: [
        {
          installedSkillId: "skill",
          name: "Skill",
          slug: "skill",
          description: null,
          markdown: "instructions",
          checksum: "a".repeat(64),
          userInvocable: true,
          agentInvocable: true,
          effort: "default",
          files: [
            { path: "asset", encoding: "base64", content: "AA==" },
            { path: "asset.binary.json", content: "ordinary text" },
          ],
        },
      ],
    };
    const result = buildAgentRevisionDiff(config, after);
    const binary = result.files.find(
      (file) => file.path === "skills/skill/files/asset",
    );
    const text = result.files.find(
      (file) => file.path === "skills/skill/files/asset.binary.json",
    );
    expect(binary?.binary).toBe(true);
    expect(text?.binary).toBe(false);
    if (!text || !binary) throw new Error("Both attachments must be reviewed");
    expect(applyPatch("", text.patch)).toBe("ordinary text");
    const decoded = applyPatch("", binary.patch);
    if (decoded === false)
      throw new Error("Invalid binary representation patch");
    expect(JSON.parse(decoded)).toEqual({
      encoding: "base64",
      content: "AA==",
    });
  });
});
