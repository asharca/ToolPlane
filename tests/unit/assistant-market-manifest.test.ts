import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import {
  assistantReleaseChecksum,
  buildAssistantReleaseManifest,
  parseAssistantReleaseManifest,
  type AssistantReleaseSource,
} from "@/lib/market/assistant-manifest";
import { scanMarketArtifact } from "@/lib/market/secret-scan";
import { mcpDefinitionChecksum } from "@/lib/process/mcp-definition";

const deployment = {
  name: "Web search",
  serverId: "catalog",
  source: "remote",
  sourceRef: "https://example.com/mcp",
  installCfg: {},
  server: { slug: "web-search", name: "Web search" },
};
const source: AssistantReleaseSource = {
  name: "Research assistant",
  config: {
    schemaVersion: 1,
    systemPrompt: "Summarize sources with citations.",
    modelProviderId: "provider",
    model: "gpt-5.6",
    modelParameters: { temperature: 0.2 },
    maxSteps: 8,
    mcpGrants: [
      {
        deploymentId: "search",
        allowedToolNames: ["search"],
        definitionChecksum: mcpDefinitionChecksum(deployment),
      },
    ],
  },
  modelProvider: { format: "openai-compatible" },
  mcpGrants: [{ deploymentId: "search", deployment }],
};

describe("assistant market manifests", () => {
  it("keeps only portable requirements and verifies a stable checksum", () => {
    const manifest = buildAssistantReleaseManifest(source);
    const checksum = assistantReleaseChecksum(manifest);

    expect(parseAssistantReleaseManifest(manifest, checksum)).toEqual(manifest);
    expect(manifest.assistant).toMatchObject({
      modelRequirement: {
        providerFormat: "openai-compatible",
        model: "gpt-5.6",
      },
      modelParameters: { temperature: 0.2 },
      mcpRequirements: [
        {
          catalogSlug: "web-search",
          name: "Web search",
          allowedToolNames: ["search"],
        },
      ],
    });
    expect(assistantReleaseChecksum({ ...manifest })).toBe(checksum);
  });

  it("rejects checksum changes and blocks credentials in assistant text", () => {
    const manifest = buildAssistantReleaseManifest(source);
    expect(() =>
      parseAssistantReleaseManifest(manifest, "0".repeat(64)),
    ).toThrow("checksum");

    const secret = `sk-proj-${"a".repeat(24)}`;
    const result = scanMarketArtifact({
      ...manifest,
      assistant: { ...manifest.assistant, systemPrompt: secret },
    });
    expect(result).toMatchObject({
      status: "blocked",
      findings: [
        { kind: "openai_key", path: "manifest.assistant.systemPrompt" },
      ],
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("uses the shared agent tool-loop bounds", () => {
    expect(
      buildAssistantReleaseManifest({
        ...source,
        config: { ...source.config, maxSteps: 1_000 },
      }).assistant.maxSteps,
    ).toBe(1_000);
    expect(() =>
      buildAssistantReleaseManifest({
        ...source,
        config: { ...source.config, maxSteps: 0 },
      }),
    ).toThrow(ZodError);
    expect(() =>
      buildAssistantReleaseManifest({
        ...source,
        config: { ...source.config, maxSteps: 1_001 },
      }),
    ).toThrow(ZodError);
  });
});
