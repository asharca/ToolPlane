import "server-only";

import { z } from "zod";
import { AGENT_STEP_BOUNDS } from "@/lib/agents/constants";
import { marketReleaseChecksum } from "@/lib/market/artifact";
import {
  ChatAssistantRevisionConfigSchema,
  type ChatAssistantRevisionConfig,
} from "@/lib/chat/revision-types";
import { ChatAssistantModelParametersSchema } from "@/lib/chat/schemas";
import type { DeploymentForSpawn } from "@/lib/process/spawn-spec";
import { assertAssistantRemoteDeployment } from "@/lib/remote-mcp/classification";
import { mcpDefinitionChecksum } from "@/lib/process/mcp-definition";

export const ASSISTANT_MARKET_MANIFEST_VERSION = 1 as const;

const assistantReleaseListingSchema = z
  .object({
    slug: z.string().min(1).max(100),
    name: z.string().min(1).max(240),
    summary: z.string().max(4_000).nullable(),
    iconUrl: z.string().max(2_000).nullable(),
    tags: z.array(z.string().min(1).max(40)).max(20),
    author: z.string().min(1).max(240),
  })
  .strict();

const assistantReleaseManifestSchema = z
  .object({
    schemaVersion: z.literal(ASSISTANT_MARKET_MANIFEST_VERSION),
    kind: z.literal("assistant"),
    listing: assistantReleaseListingSchema.optional(),
    assistant: z
      .object({
        name: z.string().min(1).max(120),
        systemPrompt: z.string().max(50_000).nullable(),
        maxSteps: z
          .number()
          .int()
          .min(AGENT_STEP_BOUNDS.min)
          .max(AGENT_STEP_BOUNDS.max),
        modelRequirement: z
          .object({
            providerFormat: z.string().min(1).max(120),
            model: z.string().min(1).max(240).nullable(),
          })
          .strict()
          .nullable(),
        modelParameters: ChatAssistantModelParametersSchema.nullable(),
        mcpRequirements: z
          .array(
            z
              .object({
                catalogSlug: z.string().min(1).max(120),
                name: z.string().min(1).max(240),
                allowedToolNames: z
                  .array(z.string().min(1).max(240))
                  .max(1_000),
              })
              .strict(),
          )
          .max(50),
      })
      .strict(),
  })
  .strict();

export type AssistantReleaseManifestV1 = z.infer<
  typeof assistantReleaseManifestSchema
>;
export type AssistantReleaseListingV1 = z.infer<
  typeof assistantReleaseListingSchema
>;

export type AssistantReleaseSource = {
  name: string;
  config: ChatAssistantRevisionConfig;
  modelProvider: { format: string } | null;
  mcpGrants: Array<{
    deploymentId: string;
    deployment: DeploymentForSpawn & {
      server: { slug: string; name: string } | null;
    };
  }>;
};

function portableSlug(value: string, fallback: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 120) || fallback
  );
}

export function buildAssistantReleaseManifest(
  source: AssistantReleaseSource,
  listing?: AssistantReleaseListingV1,
): AssistantReleaseManifestV1 {
  const config = ChatAssistantRevisionConfigSchema.parse(source.config);
  if (config.modelProviderId && !source.modelProvider) {
    throw new Error("The pinned Assistant model provider is unavailable.");
  }
  const requirements = new Map<
    string,
    { catalogSlug: string; name: string; allowedToolNames: string[] }
  >();
  for (const [index, grant] of config.mcpGrants.entries()) {
    const binding = source.mcpGrants.find(
      (item) => item.deploymentId === grant.deploymentId,
    );
    if (!binding)
      throw new Error("A pinned Assistant MCP deployment is unavailable.");
    const { deployment } = binding;
    assertAssistantRemoteDeployment(deployment);
    if (mcpDefinitionChecksum(deployment) !== grant.definitionChecksum)
      throw new Error(
        "The pinned Assistant MCP connection definition changed.",
      );
    if (!deployment.server?.slug) {
      throw new Error(
        "Assistant MCP requirements must reference a portable remote catalog server.",
      );
    }
    const name = (
      deployment.name ||
      deployment.server.name ||
      "MCP server"
    ).slice(0, 240);
    const catalogSlug = portableSlug(
      deployment.server.slug,
      `mcp-server-${index + 1}`,
    );
    const existing = requirements.get(catalogSlug);
    requirements.set(catalogSlug, {
      catalogSlug,
      name,
      allowedToolNames: [
        ...new Set([
          ...(existing?.allowedToolNames ?? []),
          ...grant.allowedToolNames,
        ]),
      ],
    });
  }
  const mcpRequirements = [...requirements.values()];
  return parseAssistantReleaseManifest({
    schemaVersion: ASSISTANT_MARKET_MANIFEST_VERSION,
    kind: "assistant",
    ...(listing ? { listing } : {}),
    assistant: {
      name: source.name,
      systemPrompt: config.systemPrompt,
      maxSteps: config.maxSteps,
      modelRequirement:
        config.modelProviderId && source.modelProvider
          ? { providerFormat: source.modelProvider.format, model: config.model }
          : null,
      modelParameters: config.modelParameters,
      mcpRequirements,
    },
  });
}

export function parseAssistantReleaseManifest(
  raw: unknown,
  expectedChecksum?: string,
): AssistantReleaseManifestV1 {
  const parsed = assistantReleaseManifestSchema.safeParse(raw);
  if (!parsed.success)
    throw new Error("The assistant release manifest is invalid.");
  if (
    Buffer.byteLength(JSON.stringify(parsed.data), "utf8") >
    24 * 1024 * 1024
  ) {
    throw new Error("The assistant release manifest is too large.");
  }
  if (
    expectedChecksum !== undefined &&
    (!/^[a-f0-9]{64}$/.test(expectedChecksum) ||
      assistantReleaseChecksum(parsed.data) !== expectedChecksum)
  ) {
    throw new Error("The assistant release checksum does not match.");
  }
  return parsed.data;
}

export function assistantReleaseChecksum(
  manifest: AssistantReleaseManifestV1,
): string {
  return marketReleaseChecksum(manifest);
}
