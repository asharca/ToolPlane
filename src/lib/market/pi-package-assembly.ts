import "server-only";
import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { buildSkillReleaseManifest } from "@/lib/market/skill-manifest";
import type {
  PiPackageEntryV1,
  PiPackageSnapshotV1,
} from "@/lib/market/pi-package-manifest";
import { readMcpToolCatalog } from "@/lib/process/mcp-tool-catalog";
import { piPackageMcpAdapterSource } from "@/lib/pi-packages/adapter";
import { MarketError } from "@/lib/market/skills";
import { parsePiPackageReleaseManifest } from "@/lib/market/pi-package-manifest";
import { flattenPiPackages } from "@/lib/pi-packages/flatten";

export type PiPackageMcpBindings = Record<
  string,
  { deploymentId: string; tools: string[] }
>;
export type PiPackageAssemblyInput = {
  workspaceId: string;
  name: string;
  version: string;
  installedSkillIds: string[];
  mcps: Array<{ deploymentId: string; tools: string[] }>;
  packageReleaseIds?: string[];
  themes?: Array<{ name: string; content: string }>;
};

const standaloneResourceSchema = z
  .object({
    name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/),
    content: z
      .string()
      .min(1)
      .max(1024 * 1024)
      .refine((value) => Buffer.byteLength(value) <= 1024 * 1024),
  })
  .strict();
const assemblySelectionSchema = z.object({
  name: z.string().min(1).max(214),
  version: z.string().min(1).max(240),
  installedSkillIds: z.array(z.string().min(1).max(200)).max(64),
  packageReleaseIds: z.array(z.string().min(1).max(200)).max(64).optional(),
  mcps: z
    .array(
      z
        .object({
          deploymentId: z.string().min(1).max(200),
          tools: z.array(z.string().min(1).max(256)).min(1).max(256),
        })
        .strict(),
    )
    .max(64),
  themes: z.array(standaloneResourceSchema).max(64).optional(),
});

export function readPiAssemblyFormData(
  formData: FormData,
): Omit<PiPackageAssemblyInput, "workspaceId"> {
  try {
    const mcps = new Map<string, string[]>();
    const rawTools = formData.getAll("mcpTools");
    if (rawTools.length > 64 * 256)
      throw new MarketError("invalid_manifest", "Too many MCP selections.");
    for (const raw of rawTools) {
      if (typeof raw !== "string" || raw.length > 2048)
        throw new MarketError("invalid_manifest", "Invalid MCP selection.");
      const value: unknown = JSON.parse(raw);
      if (
        !Array.isArray(value) ||
        value.length !== 2 ||
        value.some((part) => typeof part !== "string")
      )
        throw new MarketError("invalid_manifest", "Invalid MCP selection.");
      const [id, tool] = value as [string, string];
      mcps.set(id, [...(mcps.get(id) ?? []), tool]);
    }
    const resources: Record<string, unknown> = {};
    for (const field of ["standaloneThemes"]) {
      const raw = formData.get(field) ?? "[]";
      if (typeof raw !== "string" || raw.length > 96 * 1024 * 1024)
        throw new MarketError(
          "invalid_manifest",
          "Standalone resource JSON exceeds the package intake limit.",
        );
      resources[field] = JSON.parse(raw);
    }
    const parsed = assemblySelectionSchema.safeParse({
      name: formData.get("packageName"),
      version: formData.get("packageVersion"),
      installedSkillIds: formData.getAll("installedSkillIds"),
      packageReleaseIds: formData.getAll("packageReleaseIds"),
      themes: resources.standaloneThemes,
      mcps: [...mcps].map(([deploymentId, tools]) => ({ deploymentId, tools })),
    });
    if (!parsed.success)
      throw new MarketError(
        "invalid_manifest",
        "Invalid package selections: use arrays of named Prompt/Theme files up to 1 MiB each (at most 64 per resource kind).",
      );
    return parsed.data;
  } catch (error) {
    if (error instanceof MarketError) throw error;
    throw new MarketError(
      "invalid_manifest",
      "Package selections must contain valid JSON arrays of named resource files.",
    );
  }
}

/** Read selected resources inside the publisher transaction; never serialize their identities. */
export async function assemblePiPackage(
  tx: Prisma.TransactionClient,
  input: PiPackageAssemblyInput,
): Promise<{ snapshot: PiPackageSnapshotV1; bindings: PiPackageMcpBindings }> {
  const selection = assemblySelectionSchema.safeParse(input);
  if (
    !selection.success ||
    typeof input.workspaceId !== "string" ||
    !input.workspaceId ||
    input.workspaceId.length > 200
  )
    throw new MarketError(
      "invalid_manifest",
      "Invalid package assembly input.",
    );
  input = { ...selection.data, workspaceId: input.workspaceId };
  const packageReleaseIds = input.packageReleaseIds ?? [];
  const themes = input.themes ?? [];
  if (
    !/^(?:@[a-z0-9-][a-z0-9._-]*\/)?[a-z0-9-][a-z0-9._-]*$/.test(input.name) ||
    input.name.length > 214 ||
    ["node_modules", "favicon.ico"].includes(input.name) ||
    !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
      input.version,
    ) ||
    input.installedSkillIds.length > 64 ||
    input.mcps.length > 64 ||
    new Set(input.installedSkillIds).size !== input.installedSkillIds.length ||
    new Set(input.mcps.map((item) => item.deploymentId)).size !==
      input.mcps.length ||
    packageReleaseIds.length > 64 ||
    themes.length > 64 ||
    new Set(packageReleaseIds).size !== packageReleaseIds.length ||
    (!input.installedSkillIds.length &&
      !input.mcps.length &&
      !packageReleaseIds.length &&
      !themes.length)
  )
    throw new MarketError(
      "pi_package_invalid_selection",
      "Select valid package resources and an exact npm name/version.",
    );
  const skills = await tx.installedSkill.findMany({
    where: {
      id: { in: input.installedSkillIds },
      workspaceId: input.workspaceId,
    },
    include: { skill: true },
    orderBy: { id: "asc" },
  });
  if (skills.length !== input.installedSkillIds.length)
    throw new MarketError(
      "pi_package_source_unavailable",
      "A selected Skill is unavailable.",
    );
  const deployments = await tx.deployment.findMany({
    where: {
      id: { in: input.mcps.map((item) => item.deploymentId) },
      workspaceId: input.workspaceId,
    },
    include: { server: true },
    orderBy: { id: "asc" },
  });
  if (deployments.length !== input.mcps.length)
    throw new MarketError(
      "pi_package_source_unavailable",
      "A selected MCP is unavailable.",
    );
  const releases = packageReleaseIds.length
    ? await tx.marketRelease.findMany({
        where: {
          id: { in: packageReleaseIds },
          reviewStatus: "approved",
          listing: {
            kind: "pi-package",
            status: "published",
            OR: [
              { visibility: "public" },
              {
                visibility: "private",
                publisherWorkspaceId: input.workspaceId,
              },
            ],
          },
        },
        orderBy: { id: "asc" },
      })
    : [];
  if (releases.length !== packageReleaseIds.length)
    throw new MarketError(
      "pi_package_source_unavailable",
      "Select an approved immutable package release accessible to this workspace.",
    );
  const entries: PiPackageEntryV1[] = [];
  function file(path: string, bytes: Buffer) {
    const previous = entries.find((entry) => entry.path === path);
    if (previous) {
      if (
        previous.type === "file" &&
        previous.content === bytes.toString("base64")
      )
        return;
      throw new MarketError(
        "pi_package_invalid_selection",
        `Conflicting content for ${path}; choose one resource.`,
      );
    }
    entries.push({
      type: "file",
      path,
      contentEncoding: "base64",
      content: bytes.toString("base64"),
      executable: false,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  const resources: PiPackageSnapshotV1["resources"] = {
    extensions: [],
    skills: [],
    prompts: [],
    themes: [],
  };
  const origins: NonNullable<
    NonNullable<PiPackageSnapshotV1["toolplane"]>["origins"]
  > = [];
  for (const source of skills) {
    const skill = buildSkillReleaseManifest(source).skill;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(skill.slug))
      throw new MarketError(
        "pi_package_invalid_selection",
        "Selected Skill has an invalid portable name; choose a valid source.",
      );
    const key = skill.slug;
    const root = `package/skills/${key}`;
    file(`${root}/SKILL.md`, Buffer.from(skill.content));
    for (const extra of skill.files)
      file(
        `${root}/${extra.path}`,
        Buffer.from(
          extra.content,
          extra.encoding === "base64" ? "base64" : "utf8",
        ),
      );
    resources.skills.push(`${root}/SKILL.md`);
    const digest = createHash("sha256")
      .update(JSON.stringify({ content: skill.content, files: skill.files }))
      .digest("hex");
    origins.push({
      kind: "skills",
      path: `${root}/SKILL.md`,
      identity: `skill:${skill.slug}`,
      digest,
      sources: [
        {
          name: `skill:${skill.slug}`,
          version: skill.source.revision ?? null,
          path: "SKILL.md",
          digest,
        },
      ],
    });
  }
  for (const selection of themes) {
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(selection.name) ||
      !selection.content ||
      Buffer.byteLength(selection.content) > 1024 * 1024
    )
      throw new MarketError(
        "pi_package_invalid_selection",
        "Invalid standalone themes name/content.",
      );
    const path = `package/themes/${selection.name}.json`;
    const theme: unknown = JSON.parse(selection.content);
    if (!theme || typeof theme !== "object" || Array.isArray(theme))
      throw new MarketError(
        "pi_package_invalid_selection",
        "Theme must be a JSON object.",
      );
    file(path, Buffer.from(selection.content));
    const digest = createHash("sha256").update(selection.content).digest("hex");
    origins.push({
      kind: "themes",
      path,
      identity: `themes:${selection.name}`,
      digest,
      sources: [
        {
          name: `standalone-themes:${selection.name}`,
          version: null,
          path: `${selection.name}.json`,
          digest,
        },
      ],
    });
    resources.themes.push(path);
  }
  const bindings: PiPackageMcpBindings = {};
  const mcp: NonNullable<PiPackageSnapshotV1["toolplane"]>["mcp"] = [];
  for (const deployment of deployments) {
    const selection = input.mcps.find(
      (item) => item.deploymentId === deployment.id,
    );
    if (!selection)
      throw new MarketError(
        "pi_package_source_unavailable",
        "A selected MCP is unavailable.",
      );
    const tools = [...selection.tools].sort();
    const catalog = readMcpToolCatalog(deployment.installCfg);
    const names = new Set(catalog.map((tool) => tool.name));
    if (
      !tools.length ||
      tools.length > 256 ||
      new Set(tools).size !== tools.length ||
      tools.some(
        (name) =>
          !names.has(name) ||
          (deployment.mcpToolExposure === "allowlist" &&
            !deployment.mcpAllowedTools.includes(name)),
      )
    )
      throw new MarketError(
        "pi_package_tools_unavailable",
        "Selected MCP tools are unavailable.",
      );
    const key = `mcp-${createHash("sha256").update(deployment.id).digest("hex").slice(0, 16)}`;
    mcp.push({
      key,
      name: deployment.name || deployment.server?.name || key,
      tools,
    });
    bindings[key] = { deploymentId: deployment.id, tools };
  }
  if (mcp.length) {
    resources.extensions.push("package/extensions/toolplane-mcp.mjs");
    file(
      "package/extensions/toolplane-mcp.mjs",
      Buffer.from(piPackageMcpAdapterSource()),
    );
  }
  const pi = {
    extensions: resources.extensions.map((path) =>
      path.slice("package/".length),
    ),
    skills: resources.skills.map((path) => path.slice("package/".length)),
    themes: resources.themes.map((path) => path.slice("package/".length)),
  };
  file(
    "package/package.json",
    Buffer.from(
      `${JSON.stringify({ name: input.name, version: input.version, type: "module", keywords: ["pi-package"], pi, toolplane: { schemaVersion: 1, mcp } }, null, 2)}\n`,
    ),
  );
  const result = {
    bindings,
    snapshot: {
      source: {
        kind: "toolplane",
        requested: `toolplane:${input.name}@${input.version}`,
        name: input.name,
        version: input.version,
      },
      name: input.name,
      version: input.version,
      runtime: {
        kind: "pi-sdk",
        piVersion: "0.87.1",
        nodeMajor: 26,
        platform: "any",
        arch: "any",
      },
      root: "package",
      resources,
      entries: entries.sort((a, b) =>
        a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
      ),
      toolplane: { schemaVersion: 1, mcp, origins },
    },
  };
  const snapshot = flattenPiPackages([
    result.snapshot as PiPackageSnapshotV1,
    ...releases.map(
      (release) =>
        parsePiPackageReleaseManifest(release.manifest, release.checksum)
          .package,
    ),
  ]);
  const piDeclarations = Object.fromEntries(
    Object.entries(snapshot.resources).map(([kind, paths]) => [
      kind,
      paths.map((path) => path.slice("package/".length)),
    ]),
  );
  const bytes = Buffer.from(
    `${JSON.stringify({ name: input.name, version: input.version, type: "module", keywords: ["pi-package"], pi: piDeclarations, toolplane: snapshot.toolplane }, null, 2)}\n`,
  );
  snapshot.entries.push({
    type: "file",
    path: "package/package.json",
    contentEncoding: "base64",
    content: bytes.toString("base64"),
    executable: false,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  snapshot.entries.sort((a, b) => a.path.localeCompare(b.path));
  return { snapshot, bindings };
}

export async function validatePiPackageMcpBindings(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  manifest: PiPackageSnapshotV1,
  bindings: PiPackageMcpBindings,
): Promise<void> {
  const requirements = manifest.toolplane?.mcp ?? [];
  if (
    !bindings ||
    typeof bindings !== "object" ||
    Array.isArray(bindings) ||
    Object.keys(bindings).some(
      (key) => !requirements.some((item) => item.key === key),
    )
  )
    throw new MarketError(
      "pi_package_invalid_bindings",
      "Invalid package MCP bindings.",
    );
  for (const [key, binding] of Object.entries(bindings)) {
    const requirement = requirements.find((item) => item.key === key);
    if (
      !requirement ||
      !binding ||
      typeof binding.deploymentId !== "string" ||
      !Array.isArray(binding.tools) ||
      new Set(binding.tools).size !== binding.tools.length ||
      binding.tools.length !== requirement.tools.length ||
      binding.tools.some((name) => !requirement.tools.includes(name))
    )
      throw new MarketError(
        "pi_package_invalid_bindings",
        "Invalid package MCP bindings.",
      );
    const deployment = await tx.deployment.findFirst({
      where: { id: binding.deploymentId, workspaceId },
      select: {
        installCfg: true,
        mcpToolExposure: true,
        mcpAllowedTools: true,
      },
    });
    const available = new Set(
      deployment
        ? readMcpToolCatalog(deployment.installCfg).map((tool) => tool.name)
        : [],
    );
    if (
      !deployment ||
      binding.tools.some(
        (name) =>
          !available.has(name) ||
          (deployment.mcpToolExposure === "allowlist" &&
            !deployment.mcpAllowedTools.includes(name)),
      )
    )
      throw new MarketError(
        "pi_package_tools_unavailable",
        "Selected MCP tools are unavailable.",
      );
  }
}
