import "server-only";

import { createHash } from "node:crypto";
import { z } from "zod";
import { parseAssistantReleaseManifest } from "@/lib/market/assistant-manifest";
import { marketReleaseChecksum } from "@/lib/market/artifact";
import { resourceListingSchema } from "@/lib/market/listing-schema";
import { parseMcpMarketManifest } from "@/lib/market/resources";
import { assertPortableMcpRecipe } from "@/lib/market/mcp-portable-recipe";
import { captureGithubRegistryPiPackage } from "@/lib/market/pi-package-source";
import {
  parsePiPackageReleaseManifest,
  scanPiPackageReleaseManifest,
  projectPiPackageSummary,
} from "@/lib/market/pi-package-manifest";
import { parseSkillReleaseManifest } from "@/lib/market/skill-manifest";
import {
  scanMarketArtifact,
  scanSkillReleaseManifest,
  type MarketSecretScan,
} from "@/lib/market/secret-scan";
import { encodeSkillFile } from "@/lib/skills/bundle";
import { hasMcpToolCatalog } from "@/lib/process/mcp-tool-catalog";
import {
  GithubRegistryError,
  parseJsonFile,
  type GithubRegistryEntry,
} from "./github-registry-source";

const headerSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("pi-package"),
    listing: resourceListingSchema,
  })
  .strict();
const skillDescriptorSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("skill"),
    listing: resourceListingSchema,
    skill: z
      .object({
        name: z.string().min(1).max(240),
        slug: z.string().min(1).max(120),
        description: z.string().max(4000).nullable(),
        userInvocable: z.boolean(),
        agentInvocable: z.boolean(),
        effort: z.string().min(1).max(64),
      })
      .strict(),
  })
  .strict();
export type GithubRegistryFile = {
  path: string;
  data: Buffer;
  executable?: boolean;
};
export type GithubRegistryArtifact = {
  manifest: unknown;
  listing: z.infer<typeof resourceListingSchema>;
  checksum: string;
  scan: MarketSecretScan;
  summary: Record<string, unknown>;
};
export function githubDirectoryDigest(
  repository: string,
  path: string,
  kind: string,
  files: GithubRegistryFile[],
) {
  // Provenance commit changes when unrelated resources change. Identity is the complete directory bytes.
  const hash = createHash("sha256").update(
    JSON.stringify([repository.toLowerCase(), path, kind]),
  );
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    hash
      .update(
        JSON.stringify([file.path, file.data.length, file.executable ?? false]),
      )
      .update(file.data);
  }
  return hash.digest("hex");
}
export async function buildGithubRegistryRelease(input: {
  entry: GithubRegistryEntry;
  repository: string;
  commit: string;
  path: string;
  files: GithubRegistryFile[];
}): Promise<GithubRegistryArtifact> {
  const descriptor = input.files.find((file) => file.path === "resource.json");
  if (!descriptor || descriptor.data.length > 4_000_000)
    throw new GithubRegistryError("resource_descriptor_missing");
  const raw = parseJsonFile(descriptor.data);
  let manifest: unknown;
  let scan: MarketSecretScan;
  let summary: Record<string, unknown> = {};
  if (input.entry.kind === "skill") {
    const parsed = skillDescriptorSchema.safeParse(raw);
    if (!parsed.success)
      throw new GithubRegistryError("resource_descriptor_invalid");
    const markdown = input.files.find((file) => file.path === "SKILL.md");
    if (!markdown) throw new GithubRegistryError("skill_markdown_missing");
    const content = new TextDecoder("utf-8", { fatal: true }).decode(
      markdown.data,
    );
    const skill = parseSkillReleaseManifest({
      ...parsed.data,
      skill: {
        ...parsed.data.skill,
        content,
        files: input.files
          .filter(
            (file) => file.path !== "resource.json" && file.path !== "SKILL.md",
          )
          .map((file) => ({
            path: file.path,
            ...encodeSkillFile(file.data, file.path),
          })),
        source: {
          type: "github",
          reference: `https://github.com/${input.repository}/tree/${input.commit}/${input.path}`,
          revision: input.commit,
        },
      },
    });
    manifest = skill;
    scan = scanSkillReleaseManifest(skill);
    summary = {
      fileCount: skill.skill.files.length,
      source: "github",
      effort: skill.skill.effort,
    };
  } else if (input.entry.kind === "pi-package") {
    const parsed = headerSchema.safeParse(raw);
    if (!parsed.success)
      throw new GithubRegistryError("resource_descriptor_invalid");
    const snapshot = await captureGithubRegistryPiPackage({
      repository: input.repository,
      commit: input.commit,
      path: input.path,
      files: input.files.filter((file) => file.path !== "resource.json"),
    });
    const release = parsePiPackageReleaseManifest({
      ...parsed.data,
      package: snapshot,
    });
    manifest = release;
    scan = scanPiPackageReleaseManifest(release);
    summary = { ...projectPiPackageSummary(snapshot) };
  } else if (input.entry.kind === "mcp") {
    const descriptor = z
      .object({
        mcp: z
          .object({ recipe: z.object({ source: z.string() }) })
          .passthrough(),
      })
      .safeParse(raw);
    if (!descriptor.success)
      throw new GithubRegistryError("resource_descriptor_invalid");
    if (
      descriptor.data.mcp.recipe.source !== "remote" &&
      !hasMcpToolCatalog(descriptor.data.mcp)
    ) {
      throw new GithubRegistryError("resource_mcp_tool_catalog_invalid");
    }
    const release = parseMcpMarketManifest(raw);
    assertPortableMcpRecipe(release.mcp.recipe);
    manifest = release;
    scan = scanMarketArtifact(release);
    summary = {
      source: release.mcp.recipe.source,
      requiredEnv: release.mcp.recipe.env,
      toolCount: release.mcp.toolCatalog?.length ?? 0,
    };
  } else if (input.entry.kind === "assistant") {
    const release = parseAssistantReleaseManifest(raw);
    if (!release.listing)
      throw new GithubRegistryError("resource_listing_missing");
    manifest = release;
    scan = scanMarketArtifact(release);
    summary = {
      providerFormat:
        release.assistant.modelRequirement?.providerFormat ?? null,
      model: release.assistant.modelRequirement?.model ?? null,
    };
  } else {
    throw new GithubRegistryError("resource_kind_unsupported");
  }
  if (scan.status === "blocked")
    throw new GithubRegistryError("resource_secrets_detected");
  const header = z
    .object({ listing: resourceListingSchema })
    .safeParse(manifest);
  if (!header.success)
    throw new GithubRegistryError("resource_listing_invalid");
  return {
    manifest,
    listing: header.data.listing,
    checksum: marketReleaseChecksum(manifest),
    scan,
    summary,
  };
}
