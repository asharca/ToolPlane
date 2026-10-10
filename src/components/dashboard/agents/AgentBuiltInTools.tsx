"use client";

import { FormCheckbox } from "@/components/ui/FormCheckbox";

import { useTranslations } from "next-intl";
import {
  agentRuntimeBuiltinToolGroups,
  agentRuntimeSupportsBuiltinToolSelection,
  type AgentRuntimeBuiltinToolCategory,
} from "@/lib/agents/runtime-kind";

export function AgentBuiltInTools({
  runtimeKind,
  disabledTools,
  onDisabledToolsChange,
  fieldName = "disabledBuiltinTool",
}: {
  runtimeKind: string;
  disabledTools: ReadonlySet<string>;
  onDisabledToolsChange: (tools: Set<string>) => void;
  fieldName?: string;
}) {
  const t = useTranslations("console.agents");
  const labels: Record<AgentRuntimeBuiltinToolCategory, string> = {
    file: t("toolCategoryFile"),
    shell: t("toolCategoryShell"),
    search: t("toolCategorySearch"),
    context: t("toolCategoryContext"),
    orchestration: t("toolCategoryOrchestration"),
    browser: t("toolCategoryBrowser"),
    media: t("toolCategoryMedia"),
  };
  const groups = agentRuntimeBuiltinToolGroups(runtimeKind);
  const selectable = agentRuntimeSupportsBuiltinToolSelection(runtimeKind);

  return (
    <div className="space-y-3">
      {selectable
        ? [...disabledTools].map((tool) => (
            <input key={tool} type="hidden" name={fieldName} value={tool} />
          ))
        : null}
      <ul
        aria-label={t("builtInTools")}
        className="m-0 grid list-none gap-x-8 gap-y-5 p-0 sm:grid-cols-2"
      >
        {groups.map((group) => {
          const enabled = group.tools.every((tool) => !disabledTools.has(tool));
          return (
            <li key={group.category} className="min-w-0">
              {selectable ? (
                <div className="flex cursor-pointer items-center gap-2 text-xs font-semibold text-foreground">
                  <FormCheckbox
                    checked={enabled}
                    label={t("enableBuiltInToolGroup", {
                      category: labels[group.category],
                    })}
                    onCheckedChange={() => {
                      const next = new Set(disabledTools);
                      for (const tool of group.tools) {
                        if (enabled) next.add(tool);
                        else next.delete(tool);
                      }
                      onDisabledToolsChange(next);
                    }}
                  />
                </div>
              ) : (
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {labels[group.category]}
                </p>
              )}
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
                {group.tools.map((tool) => (
                  <code key={tool} className="text-xs text-foreground">
                    {tool}
                  </code>
                ))}
              </div>
            </li>
          );
        })}
      </ul>
      {!selectable ? (
        <p className="text-xs leading-5 text-muted-foreground">
          {t("hermesBuiltInToolsDescription")}
        </p>
      ) : null}
    </div>
  );
}
