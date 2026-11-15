"use client";

import { FormCheckbox } from "@/components/ui/FormCheckbox";

import { useTranslations } from "next-intl";
import {
  agentRuntimeBuiltinToolGroups,
  agentRuntimeSupportsBuiltinToolSelection,
  type AgentRuntimeBuiltinToolCategory,
  type AgentOptionalBuiltinTool,
} from "@/lib/agents/runtime-kind";

export function AgentBuiltInTools({
  runtimeKind,
  disabledTools,
  onDisabledToolsChange,
  fieldName = "disabledBuiltinTool",
  optionalToolOptions,
  enabledOptionalTools,
  onEnabledOptionalToolsChange,
  disabled = false,
}: {
  runtimeKind: string;
  disabledTools: ReadonlySet<string>;
  onDisabledToolsChange: (tools: Set<string>) => void;
  fieldName?: string;
  optionalToolOptions: readonly AgentOptionalBuiltinTool[];
  enabledOptionalTools: ReadonlySet<string>;
  onEnabledOptionalToolsChange: (tools: Set<string>) => void;
  disabled?: boolean;
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
  const optionalGroups = new Map<
    AgentRuntimeBuiltinToolCategory,
    AgentOptionalBuiltinTool[]
  >();
  for (const tool of optionalToolOptions) {
    const group = optionalGroups.get(tool.category);
    if (group) group.push(tool);
    else optionalGroups.set(tool.category, [tool]);
  }

  return (
    <div className="space-y-3">
      <input
        type="hidden"
        name="optionalBuiltinTools"
        value={JSON.stringify([...enabledOptionalTools].sort())}
      />
      {selectable
        ? [...disabledTools].map((tool) => (
            <input key={tool} type="hidden" name={fieldName} value={tool} />
          ))
        : null}
      <ul
        aria-label={t("builtInTools")}
        className="m-0 grid list-none gap-3 p-0 sm:grid-cols-2"
      >
        {groups.map((group) => {
          const enabled = group.tools.every((tool) => !disabledTools.has(tool));
          return (
            <li
              key={group.category}
              className="min-w-0 rounded-xl border border-border/60 bg-muted/15 p-4"
            >
              {selectable ? (
                <div className="flex cursor-pointer items-center gap-2 text-xs font-semibold text-foreground">
                  <FormCheckbox
                    checked={enabled}
                    disabled={disabled}
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
              <div className="mt-3 flex flex-wrap gap-2">
                {group.tools.map((tool) => (
                  <code
                    key={tool}
                    className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground"
                  >
                    {tool}
                  </code>
                ))}
              </div>
            </li>
          );
        })}
      </ul>
      {optionalGroups.size > 0 ? (
        <fieldset
          className="min-w-0 space-y-3"
          disabled={disabled || !selectable}
        >
          <legend className="text-sm font-medium text-foreground">
            {t("optionalBuiltinTools")}
          </legend>
          <ul className="m-0 grid list-none gap-3 p-0 sm:grid-cols-2">
            {[...optionalGroups].map(([category, tools]) => (
              <li
                key={category}
                className="min-w-0 rounded-xl border border-border/60 bg-muted/15 p-4"
              >
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {labels[category]}
                </p>
                <div className="mt-3 flex flex-col gap-3">
                  {tools.map((tool) => (
                    <FormCheckbox
                      key={tool.name}
                      label={tool.name}
                      checked={enabledOptionalTools.has(tool.name)}
                      disabled={disabled || !selectable}
                      onCheckedChange={(enabled) => {
                        const next = new Set(enabledOptionalTools);
                        if (enabled) next.add(tool.name);
                        else next.delete(tool.name);
                        onEnabledOptionalToolsChange(next);
                      }}
                    />
                  ))}
                </div>
              </li>
            ))}
          </ul>
        </fieldset>
      ) : null}
    </div>
  );
}
