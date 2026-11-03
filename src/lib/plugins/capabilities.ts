import { createHash } from "node:crypto";
import { posix } from "node:path";
import { z } from "zod";
import type { PiPackageManifestV1 } from "@/lib/pi-packages/manifest";

export type PluginCapabilities = {
  mcp: { key: string; tools: string[] }[];
  codeDigest: string;
};

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

export function computePluginCapabilities(
  manifest: PiPackageManifestV1,
): PluginCapabilities {
  const snapshot = manifest.package;
  const packageJsonPath = posix.join(snapshot.root, "package.json");
  const resourcePaths = [
    ...snapshot.resources.skills,
    ...snapshot.resources.prompts,
    ...snapshot.resources.themes,
  ].map((path) => {
    const normalized = path.replace(/^\.\//, "").replace(/\/$/, "");
    return normalized.startsWith(`${snapshot.root}/`)
      ? normalized
      : posix.join(snapshot.root, normalized);
  });
  const files: [string, string][] = [];
  for (const entry of snapshot.entries) {
    if (
      entry.type !== "file" ||
      resourcePaths.some(
        (path) => entry.path === path || entry.path.startsWith(`${path}/`),
      )
    )
      continue;
    let digest = entry.sha256;
    if (entry.path === packageJsonPath) {
      const pkg = JSON.parse(
        Buffer.from(entry.content, "base64").toString("utf8"),
      );
      delete pkg.version;
      digest = createHash("sha256").update(canonicalJson(pkg)).digest("hex");
    }
    files.push([entry.path, digest]);
  }
  files.sort(([a], [b]) => a.localeCompare(b));
  return {
    mcp: (snapshot.toolplane?.mcp ?? [])
      .map(({ key, tools }) => ({ key, tools: [...new Set(tools)].sort() }))
      .sort((a, b) => a.key.localeCompare(b.key)),
    codeDigest: createHash("sha256")
      .update(
        canonicalJson({
          files,
          runtime: snapshot.runtime,
          hooks: snapshot.resources.hooks ?? [],
          extensions: snapshot.resources.extensions,
          tools: snapshot.resources.tools ?? [],
          commands: snapshot.resources.commands ?? [],
          config: snapshot.toolplane?.config ?? {},
          enabledFeatures: snapshot.toolplane?.enabledFeatures ?? null,
          ...(snapshot.toolplane?.nativeRoleModels
            ? { nativeRoleModels: snapshot.toolplane.nativeRoleModels }
            : {}),
        }),
      )
      .digest("hex"),
  };
}

const capabilitiesSchema = z
  .object({
    mcp: z.array(
      z
        .object({ key: z.string().min(1), tools: z.array(z.string().min(1)) })
        .strict(),
    ),
    codeDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export function readCapabilities(
  releaseSummary: unknown,
): PluginCapabilities | null {
  const parsed = z
    .object({ capabilities: capabilitiesSchema })
    .safeParse(releaseSummary);
  return parsed.success ? parsed.data.capabilities : null;
}

export function requiresReview(
  from: PluginCapabilities | null,
  to: PluginCapabilities | null,
): boolean {
  if (!from || !to) return true;
  if (from.codeDigest !== to.codeDigest) return true;
  const previous = new Map(
    from.mcp.map(({ key, tools }) => [key, new Set(tools)]),
  );
  return to.mcp.some(
    ({ key, tools }) =>
      !previous.has(key) || tools.some((tool) => !previous.get(key)?.has(tool)),
  );
}
