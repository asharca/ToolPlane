"use client";

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import {
  FileDiff,
  type FileDiffLine,
  type FileDiffProps,
} from "@/components/agents/file-diff";

type DiffLanguage = NonNullable<FileDiffProps["language"]>;

const LANGUAGE_BY_EXTENSION: Record<string, DiffLanguage> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "tsx",
  mjs: "tsx",
  cjs: "tsx",
  jsx: "tsx",
  json: "json",
  sh: "bash",
  bash: "bash",
};

function headerPath(line: string, marker: "--- " | "+++ ") {
  const path = line.slice(marker.length).split("\t")[0]?.trim();
  return path && path !== "/dev/null" ? path : undefined;
}

/**
 * Map a unified patch onto FileDiff rows. File headers become the panel title;
 * the leading hunk header is implied by the line numbers, later ones stay as
 * gap markers. Unparsed tails stay visible; never infer a patch from output.
 */
function parsePatch(patch: string) {
  const source = patch.split("\n");
  if (source.at(-1) === "") source.pop();
  const lines: FileDiffLine[] = [];
  let oldPath: string | undefined;
  let newPath: string | undefined;
  let oldLine = 0;
  let newLine = 0;
  let oldRemaining = 0;
  let newRemaining = 0;
  let hunks = 0;

  source.forEach((content, index) => {
    const inHunk = oldRemaining > 0 || newRemaining > 0;
    if (!inHunk && hunks === 0 && content.startsWith("--- ")) {
      oldPath = headerPath(content, "--- ");
      return;
    }
    if (!inHunk && hunks === 0 && content.startsWith("+++ ")) {
      newPath = headerPath(content, "+++ ");
      return;
    }
    const line: FileDiffLine = { id: String(index), content };
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(content);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[3]);
      oldRemaining = Number(hunk[2] ?? 1);
      newRemaining = Number(hunk[4] ?? 1);
      if (hunks++ === 0) return;
    } else if (content.startsWith("+") && newRemaining > 0) {
      line.type = "added";
      line.newLine = newLine++;
      line.content = content.slice(1);
      newRemaining--;
    } else if (content.startsWith("-") && oldRemaining > 0) {
      line.type = "removed";
      line.oldLine = oldLine++;
      line.content = content.slice(1);
      oldRemaining--;
    } else if (
      content.startsWith(" ") &&
      oldRemaining > 0 &&
      newRemaining > 0
    ) {
      line.oldLine = oldLine++;
      line.newLine = newLine++;
      line.content = content.slice(1);
      oldRemaining--;
      newRemaining--;
    } else if (!content.startsWith("\\")) {
      // Unrecognized or truncated rows have no file line numbers.
      oldRemaining = 0;
      newRemaining = 0;
    }
    lines.push(line);
  });

  const path = newPath ?? oldPath;
  const extension = path?.split(".").at(-1)?.toLowerCase();
  return {
    path,
    lines,
    language: (extension && LANGUAGE_BY_EXTENSION[extension]) || "text",
  };
}

export function ConversationToolDiff({
  patch,
  truncated,
  firstChangedLine,
}: {
  patch: string;
  truncated?: boolean;
  firstChangedLine?: number;
}) {
  const t = useTranslations("console.agents");
  const { path, lines, language } = useMemo(() => parsePatch(patch), [patch]);

  return (
    <section
      className="min-w-0 max-w-full space-y-1 overflow-hidden"
      aria-label={t("toolDiff")}
    >
      <FileDiff
        file={
          <span
            title={
              firstChangedLine === undefined
                ? path
                : t("toolDiffFirstChangedLine", { line: firstChangedLine })
            }
          >
            {path ?? t("toolDiff")}
          </span>
        }
        lines={lines}
        language={language}
        status="complete"
        collapseOnComplete={false}
        defaultOpen={lines.length <= 40 && patch.length <= 8000}
        maxHeight={440}
        copyText={patch}
        className="min-w-0 max-w-full"
      />
      {truncated ? (
        <p role="status" className="text-xs text-muted-foreground">
          {t("toolDiffTruncated")}
        </p>
      ) : null}
    </section>
  );
}
