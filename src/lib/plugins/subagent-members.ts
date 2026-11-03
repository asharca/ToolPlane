import type { PiPackageSnapshotV1 } from "@/lib/pi-packages/manifest";
import {
  SubagentDefinitionSchema,
  OmpModelHintSchema,
} from "@/lib/agents/capability-contracts";
import { agentRuntimeBuiltinToolGroups } from "@/lib/agents/runtime-kind";
import { parseSkillFrontmatter } from "@/lib/skills/frontmatter";

export function parseSubagentMarkdown(path: string, content: string) {
  const metadata = parseSkillFrontmatter(content);
  const name =
    metadata.name?.trim() ||
    path.split("/").at(-1)?.replace(/\.md$/i, "") ||
    "Imported subagent";
  const available = agentRuntimeBuiltinToolGroups("omp").flatMap((group) => [
    ...group.tools,
  ]);
  let builtinTools = available;
  if (metadata.tools !== undefined) {
    let value: unknown;
    try {
      value = JSON.parse(metadata.tools);
    } catch {
      value = metadata.tools
        .replace(/^\[|\]$/g, "")
        .split(",")
        .map((tool) => tool.trim().replace(/^['"]|['"]$/g, ""))
        .filter(Boolean);
    }
    if (
      !Array.isArray(value) ||
      value.some(
        (tool) => typeof tool !== "string" || !available.includes(tool),
      )
    )
      throw new Error("Invalid subagent builtin tools");
    builtinTools = value;
  }
  // A safe source label is a hint only; workspace mappings live in the manifest.
  if (metadata.model !== undefined) OmpModelHintSchema.parse(metadata.model);
  return SubagentDefinitionSchema.parse({
    schemaVersion: 1,
    runtimeKind: "omp",
    name,
    description: metadata.description ?? "",
    systemPrompt: content
      .replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "")
      .trim(),
    model: null,
    permissions: { builtinTools, mcpTools: [], skillIds: [] },
    maxSteps: 100,
  });
}

export function readPluginSubagentMembers(snapshot: PiPackageSnapshotV1) {
  const mappings = snapshot.toolplane?.nativeRoleModels ?? {};
  if (
    Object.keys(mappings).some(
      (path) => !snapshot.resources.subagents?.includes(path),
    )
  )
    throw new Error("Unknown native role model mapping");
  if (snapshot.resources.subagents?.length && snapshot.runtime.kind !== "omp")
    throw new Error("Plugin subagents require the OMP runtime");
  return (snapshot.resources.subagents ?? []).map((path) => {
    const entry = snapshot.entries.find((file) => file.path === path);
    if (entry?.type !== "file" || !/\.(?:json|md)$/i.test(path))
      throw new Error("Invalid plugin subagent member file");
    const content = Buffer.from(entry.content, "base64").toString("utf8");
    const definition = path.toLowerCase().endsWith(".json")
      ? SubagentDefinitionSchema.parse(JSON.parse(content))
      : parseSubagentMarkdown(path, content);
    return {
      path,
      modelHint: path.toLowerCase().endsWith(".md")
        ? parseSkillFrontmatter(content).model
        : undefined,
      modelMapping: mappings[path],
      name:
        definition.name ??
        path
          .split("/")
          .at(-1)
          ?.replace(/\.(?:json|md)$/i, "") ??
        "Imported subagent",
      definition,
    };
  });
}
