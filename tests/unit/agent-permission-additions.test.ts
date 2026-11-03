import { describe, expect, it } from "vitest";
import { agentPermissionAdditions } from "@/lib/agents/permission-additions";
import type { AgentRevisionConfig } from "@/lib/agents/revision-types";
import { AgentRevisionConfigSchema } from "@/lib/agents/revision-types";
import { emptyOmpConfig, OMP_VERSION } from "@/lib/agents/omp-config";
import { marketReleaseChecksum } from "@/lib/pi-packages/artifact";

function config(): AgentRevisionConfig {
  return {
    schemaVersion: 1,
    runtimeKind: "pi-sdk",
    systemPrompt: "Before",
    providerId: "provider",
    model: "model",
    modelProviderIds: [],
    maxSteps: 10,
    disabledBuiltinTools: ["bash"],
    sandboxTemplateId: "sandbox",
    externalSandboxes: [],
    environment: {
      kind: "docker",
      image: `image@sha256:${"a".repeat(64)}`,
      network: "none",
      piVersion: "0.87.1",
      initialSnapshot: null,
      resourceLimits: { memoryBytes: 1024, cpus: 1, pidsLimit: 64 },
      credentialReferences: [{ name: "KEY", credentialId: "credential" }],
    },
    skills: [],
    knowledgeBaseIds: ["kb"],
    packages: [],
    mcpGrants: [
      {
        deploymentId: "mcp",
        definitionChecksum: "a".repeat(64),
        runtimeImageDigest: null,
        runtimeFilesChecksum: "b".repeat(64),
        allowedToolNames: ["read", "write"],
      },
    ],
    a2a: {
      inboundEnabled: false,
      outboundEnabled: true,
      policy: {
        schemaVersion: 1,
        targets: [
          {
            kind: "local",
            targetId: "child",
            capabilityIds: ["read", "write"],
            maxCalls: 5,
            maxDepth: 2,
            maxConcurrent: 2,
            timeoutSeconds: 60,
            maxInputBytes: 1000,
            dataAllowance: "text_only",
            budget: {
              currency: "USD",
              maxAuthorizedCostMicros: 100,
              authorizedCostPerCallMicros: 10,
            },
          },
        ],
      },
    },
  };
}

describe("settings permission additions", () => {
  it("applies ordinary configuration changes without reconfirming existing authority", () => {
    const before = config();
    const after = config();
    after.systemPrompt = "Updated instructions";
    after.model = "other-model";
    after.maxSteps = 20;
    after.mcpGrants[0].allowedToolNames.reverse();
    after.a2a.policy.targets[0].capabilityIds.reverse();
    expect(agentPermissionAdditions(before, after)).toEqual([]);
  });
  it("does not require permission to reduce access", () => {
    const before = config();
    const after = config();
    after.disabledBuiltinTools.push("read");
    after.mcpGrants[0].allowedToolNames = ["read"];
    after.environment.credentialReferences = [];
    after.knowledgeBaseIds = [];
    after.a2a.policy.targets[0].maxCalls = 1;
    after.a2a.policy.targets[0].capabilityIds = ["read"];
    expect(agentPermissionAdditions(before, after)).toEqual([]);
  });
  it("shows additional builtin tools without requiring MCP consent", () => {
    const before = config();
    const after = config();
    after.disabledBuiltinTools = [];
    after.mcpGrants[0].allowedToolNames.push("delete");
    expect(agentPermissionAdditions(before, after)).toEqual([
      { kind: "builtin", resourceId: "builtin", values: ["bash"] },
    ]);
  });
  it("requires new consent when executable content changes behind a stable ID", () => {
    const before = config();
    before.packages = [
      { marketInstallId: "package", releaseId: "v1", integrity: "hash1" },
    ];
    const after = structuredClone(before);
    after.packages[0].releaseId = "v2";
    after.mcpGrants[0].runtimeFilesChecksum = "c".repeat(64);
    expect(agentPermissionAdditions(before, after)).toEqual([
      { kind: "package", resourceId: "package", values: ["v2"] },
    ]);
  });
  it("detects credential replacement, network expansion and additional knowledge access", () => {
    const before = config();
    const after = config();
    after.environment.credentialReferences[0].credentialId = "replacement";
    after.environment.network = "isolated";
    after.knowledgeBaseIds.push("private-kb");
    expect(agentPermissionAdditions(before, after)).toEqual([
      { kind: "knowledge", resourceId: "private-kb", values: ["private-kb"] },
      { kind: "credential", resourceId: "replacement", values: ["KEY"] },
      { kind: "environment", resourceId: "environment", values: ["network"] },
    ]);
  });
  it("detects expanded delegation and removal of a spending ceiling", () => {
    const before = config();
    const after = config();
    after.a2a.policy.targets[0].capabilityIds.push("delete");
    expect(agentPermissionAdditions(before, after)).toEqual([
      { kind: "delegation", resourceId: "child", values: ["delete"] },
    ]);
    after.a2a.policy.targets[0].budget = undefined;
    expect(agentPermissionAdditions(before, after)).toEqual([
      {
        kind: "delegation",
        resourceId: "child",
        values: ["read", "write", "delete"],
      },
    ]);
  });
  it("does not treat unapproved draft settings as existing permission", () => {
    const after = config();
    expect(agentPermissionAdditions(null, after)).toEqual(
      expect.arrayContaining([
        { kind: "credential", resourceId: "credential", values: ["KEY"] },
      ]),
    );
    expect(agentPermissionAdditions(null, after)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "mcp" })]),
    );
  });
  it("requires review for complete OMP snapshot changes and rejects mixed runtime environments", () => {
    const pi = config();
    const { piVersion: _piVersion, ...environment } = pi.environment as Extract<
      AgentRevisionConfig,
      { runtimeKind: "pi-sdk" }
    >["environment"];
    const ompConfig = emptyOmpConfig();
    const before = AgentRevisionConfigSchema.parse({
      ...pi,
      runtimeKind: "omp",
      environment: { ...environment, ompVersion: OMP_VERSION },
      ompConfig,
      ompConfigChecksum: marketReleaseChecksum(ompConfig),
    });
    expect(agentPermissionAdditions(before, structuredClone(before))).toEqual(
      [],
    );
    const changed = {
      ...ompConfig,
      files: [{ path: "APPEND_SYSTEM.md", content: "Reviewed instructions" }],
    };
    const after = AgentRevisionConfigSchema.parse({
      ...before,
      ompConfig: changed,
      ompConfigChecksum: marketReleaseChecksum(changed),
    });
    expect(agentPermissionAdditions(before, after)).toContainEqual({
      kind: "environment",
      resourceId: "environment",
      values: ["ompConfig"],
    });
    expect(
      AgentRevisionConfigSchema.safeParse({
        ...before,
        environment: pi.environment,
      }).success,
    ).toBe(false);
    expect(
      AgentRevisionConfigSchema.safeParse({
        ...pi,
        environment: before.environment,
      }).success,
    ).toBe(false);
    expect(
      AgentRevisionConfigSchema.safeParse({
        ...before,
        packages: [
          {
            marketInstallId: "pi-package",
            releaseId: "release",
            integrity: "checksum",
          },
        ],
      }).success,
    ).toBe(false);
    expect(AgentRevisionConfigSchema.parse(pi)).toEqual(pi);
  });
});
