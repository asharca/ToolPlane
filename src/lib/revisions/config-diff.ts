import { diffLines } from "diff";
import type { AgentRevisionConfig } from "@/lib/agents/revision-types";

export type RevisionDiffLine = {
  id: string;
  type: "context" | "added" | "removed";
  oldLine?: number;
  newLine?: number;
  content: string;
};
export type RevisionDiffFile = {
  path: string;
  language: "text" | "json";
  binary?: boolean;
  lines: RevisionDiffLine[];
  additions: number;
  deletions: number;
  patch: string;
};
export type AgentRevisionDiff = {
  files: RevisionDiffFile[];
  additions: number;
  deletions: number;
};

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  return value;
}

function documents(config: AgentRevisionConfig | null) {
  const result = new Map<
    string,
    { text: string; language: "text" | "json"; binary?: boolean }
  >();
  if (!config) return result;
  const json = (path: string, value: unknown, binary = false) =>
    result.set(path, {
      text: `${JSON.stringify(canonical(value), null, 2)}\n`,
      language: "json",
      binary,
    });
  const { systemPrompt, skills, ...settings } = config;
  result.set("systemPrompt.md", { text: systemPrompt ?? "", language: "text" });
  json("configuration.json", settings);
  for (const skill of skills) {
    const root = `skills/${encodeURIComponent(skill.installedSkillId)}`;
    const { markdown, files, ...metadata } = skill;
    json(`${root}/metadata.json`, metadata);
    result.set(`${root}/SKILL.md`, { text: markdown, language: "text" });
    for (const file of files) {
      // Encoded path segments cannot alias the metadata or canonical SKILL.md above.
      const path = `${root}/files/${file.path.split("/").map(encodeURIComponent).join("/")}`;
      if (file.encoding === "base64") {
        // Preserve the complete encoded representation: no lossy binary-to-text decoding.
        json(path, { encoding: "base64", content: file.content }, true);
      } else result.set(path, { text: file.content, language: "text" });
    }
  }
  return result;
}

/** Exact line differences; the work limit falls back to an honest whole-file replacement. */
export function buildAgentRevisionDiff(
  before: AgentRevisionConfig | null,
  after: AgentRevisionConfig,
): AgentRevisionDiff {
  const a = documents(before);
  const b = documents(after);
  const files: RevisionDiffFile[] = [];
  for (const path of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const previous = a.get(path);
    const next = b.get(path);
    if (previous?.text === next?.text) continue;
    const oldText = previous?.text ?? "";
    const newText = next?.text ?? "";
    const changes = diffLines(oldText, newText, { maxEditLength: 2000 }) ?? [
      { value: oldText, removed: true, added: false },
      { value: newText, removed: false, added: true },
    ];
    let oldLine = 1;
    let newLine = 1;
    let additions = 0;
    let deletions = 0;
    const lines: RevisionDiffLine[] = [];
    const patch = [
      `--- ${previous ? `a/${path}` : "/dev/null"}`,
      `+++ ${next ? `b/${path}` : "/dev/null"}`,
    ];
    for (const change of changes) {
      if (!change.value) continue;
      const values = change.value.split("\n");
      if (values.at(-1) === "") values.pop();
      for (const content of values) {
        const type = change.added
          ? "added"
          : change.removed
            ? "removed"
            : "context";
        lines.push({
          id: String(lines.length),
          type,
          content,
          ...(change.added ? {} : { oldLine: oldLine++ }),
          ...(change.removed ? {} : { newLine: newLine++ }),
        });
        if (change.added) additions++;
        if (change.removed) deletions++;
        patch.push(
          `${change.added ? "+" : change.removed ? "-" : " "}${content}`,
        );
      }
      if (!change.value.endsWith("\n"))
        patch.push("\\ No newline at end of file");
    }
    patch.splice(
      2,
      0,
      `@@ -${oldLine > 1 ? 1 : 0},${oldLine - 1} +${newLine > 1 ? 1 : 0},${newLine - 1} @@`,
    );
    files.push({
      path,
      language: next?.language ?? previous?.language ?? "text",
      binary: Boolean(next?.binary || previous?.binary),
      lines,
      additions,
      deletions,
      patch: `${patch.join("\n")}\n`,
    });
  }
  return {
    files,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
  };
}
