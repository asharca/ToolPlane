"use client";

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import { FileDiff, type FileDiffLine } from "@/components/agents/file-diff";

/** Keep headers and incomplete tails visible; never infer a patch from tool output. */
function patchLines(patch: string): FileDiffLine[] {
  const source = patch.split("\n");
  if (source.at(-1) === "") source.pop();
  let oldLine = 0;
  let newLine = 0;
  let oldRemaining = 0;
  let newRemaining = 0;

  return source.map((content, index) => {
    const line: FileDiffLine = { id: String(index), content };
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(content);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[3]);
      oldRemaining = Number(hunk[2] ?? 1);
      newRemaining = Number(hunk[4] ?? 1);
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
      // Headers (including a truncated hunk header) have no file line numbers.
      oldRemaining = 0;
      newRemaining = 0;
    }
    return line;
  });
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
  const lines = useMemo(() => patchLines(patch), [patch]);

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
                ? undefined
                : t("toolDiffFirstChangedLine", { line: firstChangedLine })
            }
          >
            {t("toolDiff")}
          </span>
        }
        lines={lines}
        language="text"
        status="complete"
        collapseOnComplete={false}
        defaultOpen={lines.length <= 40 && patch.length <= 8000}
        maxHeight={440}
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
