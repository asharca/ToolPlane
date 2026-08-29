import 'server-only';

import { z } from 'zod';
import { marketReleaseChecksum } from '@/lib/market/artifact';

export const ASSISTANT_MARKET_MANIFEST_VERSION = 1 as const;

const assistantReleaseListingSchema = z.object({
  slug: z.string().min(1).max(100),
  name: z.string().min(1).max(240),
  summary: z.string().max(4_000).nullable(),
  iconUrl: z.string().max(2_000).nullable(),
  tags: z.array(z.string().min(1).max(40)).max(20),
  author: z.string().min(1).max(240),
}).strict();

const assistantReleaseManifestSchema = z.object({
  schemaVersion: z.literal(ASSISTANT_MARKET_MANIFEST_VERSION),
  kind: z.literal('assistant'),
  listing: assistantReleaseListingSchema.optional(),
  assistant: z.object({
    name: z.string().min(1).max(120),
    systemPrompt: z.string().max(50_000).nullable(),
    maxSteps: z.number().int().min(1).max(20),
    modelRequirement: z.object({
      providerFormat: z.string().min(1).max(120),
      model: z.string().min(1).max(240).nullable(),
    }).strict().nullable(),
    mcpRequirements: z.array(z.object({
      catalogSlug: z.string().min(1).max(120),
      name: z.string().min(1).max(240),
    }).strict()).max(50),
  }).strict(),
}).strict();

export type AssistantReleaseManifestV1 = z.infer<typeof assistantReleaseManifestSchema>;
export type AssistantReleaseListingV1 = z.infer<typeof assistantReleaseListingSchema>;

export type AssistantReleaseSource = {
  name: string;
  systemPrompt: string | null;
  model: string | null;
  maxSteps: number;
  modelProvider: { format: string } | null;
  mcpGrants: Array<{
    deployment: {
      name: string | null;
      sourceRef: string | null;
      server: { slug: string; name: string } | null;
    };
  }>;
};

function portableSlug(value: string, fallback: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120) || fallback;
}

export function buildAssistantReleaseManifest(
  source: AssistantReleaseSource,
  listing?: AssistantReleaseListingV1,
): AssistantReleaseManifestV1 {
  const mcpRequirements = [...new Map(source.mcpGrants.map(({ deployment }, index) => {
    const name = (deployment.name || deployment.server?.name || deployment.sourceRef || 'MCP server').slice(0, 240);
    const catalogSlug = portableSlug(deployment.server?.slug || deployment.sourceRef || name, `mcp-server-${index + 1}`);
    return [catalogSlug, { catalogSlug, name }] as const;
  })).values()];
  return parseAssistantReleaseManifest({
    schemaVersion: ASSISTANT_MARKET_MANIFEST_VERSION,
    kind: 'assistant',
    ...(listing ? { listing } : {}),
    assistant: {
      name: source.name,
      systemPrompt: source.systemPrompt,
      maxSteps: source.maxSteps,
      modelRequirement: source.modelProvider
        ? { providerFormat: source.modelProvider.format, model: source.model }
        : null,
      mcpRequirements,
    },
  });
}

export function parseAssistantReleaseManifest(
  raw: unknown,
  expectedChecksum?: string,
): AssistantReleaseManifestV1 {
  const parsed = assistantReleaseManifestSchema.safeParse(raw);
  if (!parsed.success) throw new Error('The assistant release manifest is invalid.');
  if (Buffer.byteLength(JSON.stringify(parsed.data), 'utf8') > 128 * 1024) {
    throw new Error('The assistant release manifest is too large.');
  }
  if (expectedChecksum && assistantReleaseChecksum(parsed.data) !== expectedChecksum) {
    throw new Error('The assistant release checksum does not match.');
  }
  return parsed.data;
}

export function assistantReleaseChecksum(manifest: AssistantReleaseManifestV1): string {
  return marketReleaseChecksum(manifest);
}
