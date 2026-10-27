import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { PiPackageSnapshotV1 } from "@/lib/market/pi-package-manifest";
import { parsePromptTemplate } from "@/lib/pi-packages/prompts";
import { MarketError } from "@/lib/market/skills";
import { piPackageMcpAdapterSource } from "@/lib/pi-packages/adapter";

/** Flatten resource declarations while retaining each complete, immutable dependency tree.
 * Source directories are not installed packages: only the outer pi declarations load resources.
 */
export function flattenPiPackages(
  snapshots: PiPackageSnapshotV1[],
): PiPackageSnapshotV1 {
  const output = structuredClone(snapshots[0]);
  output.entries = [];
  output.resources = { extensions: [], skills: [], prompts: [], themes: [] };
  const origins: NonNullable<
    NonNullable<PiPackageSnapshotV1["toolplane"]>["origins"]
  > = [];
  const reproducibility: string[] = [];
  const identities = new Map<string, string>();
  const names = new Map<string, string>();
  for (const command of [
    "settings",
    "model",
    "thinking",
    "scoped-models",
    "login",
    "logout",
    "llama",
    "new",
    "resume",
    "name",
    "session",
    "tree",
    "fork",
    "clone",
    "compact",
    "import",
    "copy",
    "export",
    "share",
    "bug",
    "trust",
    "reload",
    "hotkeys",
    "changelog",
    "quit",
  ])
    names.set(`command:${command}`, "Pi 0.87.1 built-in command");
  const content = new Map<string, (typeof origins)[number]>();
  const trees = new Set<string>();
  const mcp = new Map<
    string,
    NonNullable<PiPackageSnapshotV1["toolplane"]>["mcp"][number]
  >();
  for (const snapshot of snapshots) {
    const treeDigest = createHash("sha256")
      .update(JSON.stringify(snapshot.entries))
      .digest("hex");
    const prefix = `package/sources/${treeDigest}`;
    if (snapshot.runtime.platform !== "any") {
      if (
        output.runtime.platform !== "any" &&
        (output.runtime.platform !== snapshot.runtime.platform ||
          output.runtime.arch !== snapshot.runtime.arch)
      )
        throw new MarketError(
          "pi_package_invalid_selection",
          "Selected package runtime platforms are incompatible.",
        );
      output.runtime = snapshot.runtime;
    }
    const files = new Map(snapshot.entries.map((entry) => [entry.path, entry]));
    if (
      !snapshot.entries.some((entry) =>
        /\/(?:pnpm-lock.yaml|package-lock.json|npm-shrinkwrap.json|yarn.lock)$/.test(
          entry.path,
        ),
      )
    )
      reproducibility.push(
        `${snapshot.name}@${snapshot.version ?? "content"}: no source lockfile; frozen captured dependency tree retained`,
      );
    for (const requirement of snapshot.toolplane?.mcp ?? []) {
      const previous = mcp.get(requirement.key);
      if (previous && JSON.stringify(previous) !== JSON.stringify(requirement))
        throw new MarketError(
          "pi_package_invalid_selection",
          `MCP requirement ${requirement.key} conflicts; choose one source.`,
        );
      mcp.set(requirement.key, requirement);
    }
    let needsTree = false;
    for (const kind of ["extensions", "skills", "prompts", "themes"] as const) {
      for (const path of snapshot.resources[kind]) {
        let resource = files.get(path);
        const root =
          kind === "skills"
            ? path.endsWith("/SKILL.md")
              ? posix.dirname(path)
              : path
            : path;
        if (
          resource?.type === "directory" ||
          (kind === "skills" && !path.endsWith("/SKILL.md"))
        )
          resource = files.get(`${path}/SKILL.md`);
        if (resource?.type !== "file")
          throw new MarketError(
            "pi_package_invalid_selection",
            `Resource ${snapshot.name}:${path} must resolve to a regular file before assembly.`,
          );
        let dependencyRoot = "package";
        if (kind === "extensions") {
          for (
            let directory = posix.dirname(path);
            directory !== ".";
            directory = posix.dirname(directory)
          ) {
            if (files.has(`${directory}/package.json`)) {
              dependencyRoot = directory;
              break;
            }
          }
        }
        const related =
          kind === "extensions" || kind === "skills"
            ? snapshot.entries
                .filter(
                  (entry) =>
                    entry.type !== "directory" &&
                    (entry.path ===
                      (kind === "extensions" ? dependencyRoot : root) ||
                      entry.path.startsWith(
                        `${kind === "extensions" ? dependencyRoot : root}/`,
                      )),
                )
                .sort((a, b) => a.path.localeCompare(b.path))
            : [resource];
        const text = Buffer.from(resource.content, "base64").toString("utf8");
        const dependencyDigest = createHash("sha256")
          .update(
            JSON.stringify(
              related.map((entry) => ({
                ...entry,
                path: entry.path.slice(
                  (kind === "extensions" ? dependencyRoot : root).length,
                ),
              })),
            ),
          )
          .digest("hex");
        const digest =
          kind === "extensions"
            ? createHash("sha256")
                .update(
                  text === piPackageMcpAdapterSource()
                    ? text
                    : dependencyDigest + path.slice(dependencyRoot.length),
                )
                .digest("hex")
            : dependencyDigest;
        let name = posix.basename(path).replace(/\.(md|json)$/, "");
        if (kind === "skills") {
          const metadata = parsePromptTemplate(text, {
            identity: snapshot.name,
            path: resource.path,
          }).metadata;
          name =
            typeof metadata.name === "string" && metadata.name.trim()
              ? metadata.name.trim()
              : posix.basename(root);
        }
        if (kind === "prompts")
          name = parsePromptTemplate(text, {
            identity: snapshot.name,
            path,
          }).name;
        if (kind === "themes") name = String(JSON.parse(text).name ?? name);
        const inheritedOrigin = snapshot.toolplane?.origins?.find(
          (origin) => origin.kind === kind && origin.path === path,
        );
        const identity =
          inheritedOrigin?.identity ?? `${kind}:${snapshot.name}:${path}`;
        const previous = identities.get(identity);
        if (previous && previous !== digest)
          throw new MarketError(
            "pi_package_invalid_selection",
            `Incompatible versions of ${identity}; choose one source.`,
          );
        identities.set(identity, digest);
        const source = {
          name: snapshot.name,
          version: snapshot.version,
          path,
          digest,
        };
        const contentKey = `${kind}:${kind === "extensions" ? "" : name}:${digest}`;
        const duplicate = content.get(contentKey);
        if (duplicate) {
          duplicate.sources.push(...(inheritedOrigin?.sources ?? [source]));
          continue;
        }
        const claims =
          kind === "extensions"
            ? []
            : kind === "skills"
              ? [`skills:${name}`, `command:skill:${name}`]
              : [kind === "prompts" ? `command:${name}` : `${kind}:${name}`];
        for (const claim of claims) {
          if (names.has(claim))
            throw new MarketError(
              "pi_package_invalid_selection",
              `${claim} conflicts between ${names.get(claim)} and ${snapshot.name}:${path}; choose one source (commands are not renamed).`,
            );
          names.set(claim, `${snapshot.name}:${path}`);
        }
        const target = `${prefix}/${path.slice("package/".length)}`;
        const origin = {
          kind,
          path: target,
          identity,
          digest,
          sources: inheritedOrigin?.sources ?? [source],
        };
        origins.push(origin);
        content.set(contentKey, origin);
        output.resources[kind].push(target);
        needsTree = true;
      }
    }
    if (needsTree && !trees.has(treeDigest)) {
      trees.add(treeDigest);
      for (const entry of snapshot.entries) {
        if (entry.path === "package") continue;
        output.entries.push({
          ...entry,
          path: `${prefix}/${entry.path.slice("package/".length)}`,
        });
      }
    }
  }
  output.toolplane = {
    schemaVersion: 1,
    mcp: [...mcp.values()],
    origins,
    reproducibility,
  };
  return output;
}
