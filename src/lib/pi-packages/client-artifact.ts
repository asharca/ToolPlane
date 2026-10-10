import "server-only";
import { createHash } from "node:crypto";
import { posix } from "node:path";
import type {
  PiPackageManifestV1,
  PiPackageEntryV1,
} from "@/lib/market/pi-package-manifest";
import {
  authenticatePiPackageInstallation,
  PiInstallationError,
} from "./installations";

// Project skills as ordinary files, resolving reviewed internal links without touching disk.
export function projectPiPackageSkills(manifest: PiPackageManifestV1) {
  const entries = new Map(
    manifest.package.entries.map((entry) => [entry.path, entry]),
  );
  const children = new Map<string, Set<string>>();
  for (const entry of entries.values()) {
    const parts = entry.path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const parent = parts.slice(0, i).join("/");
      let siblings = children.get(parent);
      if (!siblings) {
        siblings = new Set();
        children.set(parent, siblings);
      }
      siblings.add(parts.slice(0, i + 1).join("/"));
    }
  }
  function resolve(path: string): string {
    const seen = new Set<string>();
    for (;;) {
      if (seen.has(path))
        throw new PiInstallationError("pi_package_symlink_cycle");
      seen.add(path);
      const parts = path.split("/");
      let linked = false;
      for (let i = 1; i <= parts.length; i++) {
        const prefix = parts.slice(0, i).join("/");
        const entry = entries.get(prefix);
        if (entry?.type !== "symlink") continue;
        path = posix.normalize(
          posix.join(posix.dirname(prefix), entry.target, ...parts.slice(i)),
        );
        linked = true;
        break;
      }
      if (!linked) return path;
    }
  }
  const skillFiles = new Set<string>();
  function discover(
    path: string,
    includeRootFiles = true,
    parents = new Set<string>(),
  ) {
    const target = resolve(path);
    if (parents.has(target))
      throw new PiInstallationError("pi_package_symlink_cycle");
    if (entries.get(target)?.type === "file") {
      if (includeRootFiles && path.endsWith(".md")) skillFiles.add(path);
      return;
    }
    const declared = posix.join(path, "SKILL.md");
    if (entries.get(resolve(declared))?.type === "file") {
      skillFiles.add(declared);
      return;
    }
    const next = new Set(parents).add(target);
    for (const child of children.get(target) ?? []) {
      if (posix.basename(child).startsWith(".")) continue;
      const resource = posix.join(path, posix.basename(child));
      if (entries.get(resolve(child))?.type === "file") {
        if (includeRootFiles && resource.endsWith(".md"))
          skillFiles.add(resource);
      } else discover(resource, false, next);
    }
  }
  for (const resource of manifest.package.resources.skills) discover(resource);
  const omitted = [
    ...manifest.package.resources.extensions,
    ...manifest.package.resources.prompts,
    ...manifest.package.resources.themes,
  ].map(resolve);
  let totalFiles = 0,
    totalBytes = 0;
  return [...skillFiles].sort().map((skillFile) => {
    const directory = posix.dirname(skillFile);
    const files: Extract<PiPackageEntryV1, { type: "file" }>[] = [];
    function walk(path: string, parents = new Set<string>()) {
      const target = resolve(path);
      if (
        path !== skillFile &&
        (omitted.some(
          (resource) =>
            target === resource || target.startsWith(`${resource}/`),
        ) ||
          (posix.dirname(path) === directory &&
            posix.basename(path) === "SKILL.md"))
      )
        return;
      if (parents.has(target))
        throw new PiInstallationError("pi_package_symlink_cycle");
      const entry = entries.get(target);
      if (entry?.type === "file") {
        totalFiles++;
        totalBytes += Buffer.byteLength(entry.content, "base64");
        if (totalFiles > 20000 || totalBytes > 64 * 1024 * 1024)
          throw new PiInstallationError("pi_package_projection_too_large");
        files.push({
          ...entry,
          path:
            path === skillFile ? "SKILL.md" : posix.relative(directory, path),
        });
        return;
      }
      const next = new Set(parents).add(target);
      for (const child of children.get(target) ?? [])
        walk(posix.join(path, posix.basename(child)), next);
    }
    walk(directory);
    return {
      key: createHash("sha256").update(skillFile).digest("hex").slice(0, 20),
      files,
    };
  });
}

export async function getPiPackageClientArtifact(
  installationId: string,
  authorization: string | null,
) {
  const { installation, manifest, release, bindings } =
    await authenticatePiPackageInstallation(installationId, authorization);
  const pi = installation.client === "pi";
  const warnings =
    !pi &&
    (manifest.package.resources.extensions.length ||
      manifest.package.resources.prompts.length ||
      manifest.package.resources.themes.length)
      ? ["pi_resources_omitted"]
      : [];
  const artifact = {
    schemaVersion: 1,
    installationId,
    client: installation.client,
    releaseId: release.id,
    releaseChecksum: release.checksum,
    name: manifest.package.name,
    version: manifest.package.version,
    mcp: Object.keys(bindings).length > 0,
    warnings,
    ...(pi ? { manifest } : { skills: projectPiPackageSkills(manifest) }),
  };
  if (
    !pi &&
    !("skills" in artifact && artifact.skills?.length) &&
    !artifact.mcp
  )
    throw new PiInstallationError("pi_package_client_unsupported");
  const body = JSON.stringify(artifact);
  const sha256 = createHash("sha256").update(body).digest("hex");
  return {
    body,
    descriptor: {
      schemaVersion: 1,
      installationId,
      client: installation.client,
      releaseId: release.id,
      releaseChecksum: release.checksum,
      name: manifest.package.name,
      version: manifest.package.version,
      warnings,
      artifactSha256: sha256,
      artifactBytes: Buffer.byteLength(body),
      artifactPath: `/api/v1/pi-packages/installations/${installationId}/artifact`,
      mcpPath: `/api/v1/pi-packages/installations/${installationId}/mcp`,
    },
  };
}
