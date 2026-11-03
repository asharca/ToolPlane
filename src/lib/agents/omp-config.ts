import { z } from "zod";
import { PrivatePluginInputSchema } from "./capability-contracts";

export const OMP_VERSION = "18.14.0";
export const OMP_CONFIG_MAX_BYTES = 4 * 1024 * 1024;

// Routing, credentials and ambient discovery are not snapshot preferences.
// New executable resources come from platform bindings; legacy snapshots remain readable.
export function isOmpPrivateSetting(key: string): boolean {
  return (
    /model|provider|secret|password|credential|api.?key|auth|defaultThinkingLevel/i.test(
      key,
    ) ||
    /(?:^|\.)(?:access|refresh|bearer|runtime)?token(?:\.|$)/i.test(key) ||
    /^retry\.fallback/i.test(key) ||
    /^(?:mcp|ssh|plugins|extensionPaths|customToolPaths)(?:\.|$)/i.test(key) ||
    /^(?:browser\.relay|dev\.autoqaConsent)$/.test(key)
  );
}

export function isOmpConfigResourcePath(path: string): boolean {
  if (
    path.includes("\\") ||
    path.includes("\0") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  )
    return false;
  if (
    /(?:^|\/)(?:node_modules|\.git|\.env(?:\.[^/]*)?|models\.(?:ya?ml|json)|auth\.[^/]*|[^/]*\.(?:db|sqlite|sqlite3)(?:-[^/]*)?)(?:\/|$)/i.test(
      path,
    )
  )
    return false;
  return (
    /^(?:APPEND_SYSTEM|SYSTEM|RULES|AGENTS)\.md$/.test(path) ||
    /^(?:agents|skills|prompts|commands|rules|hooks|extensions)\/.+/.test(path)
  );
}

const json = z.json();
const file = z
  .object({ path: z.string().min(1).max(512), content: z.string() })
  .strict();

export function isOmpInstructionPath(path: string): boolean {
  return (
    isOmpConfigResourcePath(path) &&
    (/^(?:APPEND_SYSTEM|SYSTEM|RULES|AGENTS)\.md$/.test(path) ||
      /^rules\/.+/.test(path))
  );
}

export const OmpInstructionFilesSchema = z
  .array(
    file.refine(
      (entry) => isOmpInstructionPath(entry.path),
      "Invalid instruction resource path",
    ),
  )
  .max(512);
export type OmpInstructionFile = z.infer<
  typeof OmpInstructionFilesSchema
>[number];
export const OmpConfigSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    settings: z.record(z.string().max(240), json),
    files: z.array(file).max(512),
    disabledPlugins: z
      .array(
        z
          .object({
            name: z.string().min(1).max(240),
            version: z.string().min(1).max(80),
          })
          .strict(),
      )
      .max(128),
    omissions: z
      .array(
        z
          .object({ path: z.string().max(512), reason: z.string().max(500) })
          .strict(),
      )
      .max(512),
    plugins: z.array(PrivatePluginInputSchema).max(128).optional(),
  })
  .strict()
  .superRefine((snapshot, context) => {
    const paths = new Set<string>();
    for (const [index, entry] of snapshot.files.entries()) {
      if (!isOmpConfigResourcePath(entry.path) || paths.has(entry.path))
        context.addIssue({
          code: "custom",
          path: ["files", index, "path"],
          message: "Invalid or duplicate OMP resource path",
        });
      paths.add(entry.path);
      if (
        /^agents\/[^/]+\.md$/.test(entry.path) &&
        /^---\r?\n[\s\S]*?^model\s*:/m.test(entry.content)
      )
        context.addIssue({
          code: "custom",
          path: ["files", index, "content"],
          message: "Local agent model bindings must be removed",
        });
    }
    const pluginNames = new Set<string>();
    for (const [index, plugin] of (snapshot.plugins ?? []).entries()) {
      if (
        plugin.runtimeKind !== "omp" ||
        pluginNames.has(plugin.name) ||
        snapshot.disabledPlugins.some(
          (disabled) => disabled.name === plugin.name,
        )
      )
        context.addIssue({
          code: "custom",
          path: ["plugins", index],
          message: "Invalid, duplicate or disabled OMP plugin",
        });
      pluginNames.add(plugin.name);
    }
    const inspect = (value: z.infer<typeof json>, prefix: string) => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) {
        for (const item of value) inspect(item, prefix);
        return;
      }
      for (const [key, item] of Object.entries(value)) {
        const path = prefix ? `${prefix}.${key}` : key;
        if (
          isOmpPrivateSetting(path) ||
          ["__proto__", "constructor", "prototype"].includes(key)
        )
          context.addIssue({
            code: "custom",
            path: ["settings"],
            message: `Nonportable OMP setting: ${path}`,
          });
        inspect(item, path);
      }
    };
    inspect(snapshot.settings, "");
    if (
      new TextEncoder().encode(JSON.stringify(snapshot)).byteLength >
      OMP_CONFIG_MAX_BYTES
    )
      context.addIssue({
        code: "custom",
        message: "OMP configuration exceeds 4 MiB",
      });
  });

export type OmpConfigSnapshot = z.infer<typeof OmpConfigSnapshotSchema>;

export function emptyOmpConfig(): OmpConfigSnapshot {
  return {
    schemaVersion: 1,
    settings: {},
    files: [],
    disabledPlugins: [],
    omissions: [],
  };
}
