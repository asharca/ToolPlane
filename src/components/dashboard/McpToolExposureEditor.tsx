"use client";
import { AnimatedBadge } from "@/components/motion/animated-badge";

import { RadioGroup } from "@/components/motion/radio";
import { RadioGroupItem } from "@/components/motion/radio";

import { Button } from "@/components/motion/button";
import { FormCheckbox } from "@/components/ui/FormCheckbox";

import { useActionState, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Bot, CheckSquare2, Save, ShieldCheck } from "lucide-react";
import {
  updateMcpToolExposureAction,
  type McpToolExposureActionState,
} from "@/lib/workspace/actions";

type ToolSummary = {
  name: string;
  description?: string;
};

function errorMessage(
  error: McpToolExposureActionState["error"],
  t: ReturnType<typeof useTranslations>,
): string | null {
  if (!error) return null;
  return t(error);
}

export function McpToolExposureEditor({
  workspace,
  deploymentId,
  tools,
  initialMode,
  initialAllowedTools,
  initialPublicInvocable = false,
  running,
}: {
  workspace: string;
  deploymentId: string;
  tools: ToolSummary[];
  initialMode: "all" | "allowlist";
  initialAllowedTools: string[];
  initialPublicInvocable?: boolean;
  running: boolean;
}) {
  const t = useTranslations("console.mcp");
  const [state, formAction, isPending] = useActionState<
    McpToolExposureActionState,
    FormData
  >(updateMcpToolExposureAction, {});
  const [mode, setMode] = useState<"all" | "allowlist">(initialMode);
  const [selected, setSelected] = useState(
    () =>
      new Set(
        initialMode === "all"
          ? tools.map((tool) => tool.name)
          : initialAllowedTools,
      ),
  );
  const [revision, setRevision] = useState(0);

  const entries = useMemo(() => {
    const byName = new Map(
      tools.map((tool) => [tool.name, { ...tool, available: true }]),
    );
    for (const name of initialAllowedTools) {
      if (!byName.has(name)) byName.set(name, { name, available: false });
    }
    return [...byName.values()];
  }, [initialAllowedTools, tools]);

  const currentNames = useMemo(
    () => new Set(tools.map((tool) => tool.name)),
    [tools],
  );
  const exposedCurrentCount =
    mode === "all"
      ? tools.length
      : [...selected].filter((name) => currentNames.has(name)).length;
  const error = errorMessage(state.error, t);

  const selectMode = (nextMode: "all" | "allowlist") => {
    if (mode === "all" && nextMode === "allowlist") {
      setSelected(new Set(tools.map((tool) => tool.name)));
    }
    setMode(nextMode);
    setRevision((current) => current + 1);
  };
  const toggleTool = (name: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
    setRevision((current) => current + 1);
  };

  if (!running) {
    return (
      <section className="max-w-4xl">
        <div className="flex min-w-0 items-start gap-2.5">
          <Bot className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-foreground">
              {t("aiToolExposure")}
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {initialMode === "all"
                ? t("allCurrentAndFutureTools")
                : t("selectedToolCount", { count: initialAllowedTools.length })}
            </p>
          </div>
        </div>
      </section>
    );
  }

  return (
    <form action={formAction} className="max-w-4xl">
      <input type="hidden" name="workspace" value={workspace} />
      <input type="hidden" name="deploymentId" value={deploymentId} />
      <input type="hidden" name="revision" value={revision} />

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <Bot className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-foreground">
              {t("aiToolExposure")}
            </h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t("toolsExposedSummary", {
                count: exposedCurrentCount,
                total: tools.length,
              })}
            </p>
          </div>
        </div>
        <Button type="submit" disabled={isPending} variant="primary" size="sm">
          <Save className="size-3.5" />
          {isPending ? t("savingToolExposure") : t("saveToolExposure")}
        </Button>
      </div>

      <fieldset disabled={isPending} className="mt-4">
        <legend className="sr-only">{t("aiToolExposure")}</legend>
        <input type="hidden" name="mode" value={mode} disabled={isPending} />
        <RadioGroup
          value={mode}
          onValueChange={(next) => selectMode(next as "all" | "allowlist")}
          orientation="horizontal"
        >
          {(
            [
              ["all", t("allTools"), t("allCurrentAndFutureTools")],
              ["allowlist", t("selectedTools"), t("onlyCheckedTools")],
            ] as const
          ).map(([value, label, description]) => (
            <div key={value} className="space-y-2">
              <RadioGroupItem
                value={value}
                label={label}
                disabled={isPending}
              />
              <p className="text-xs text-muted-foreground">{description}</p>
            </div>
          ))}
        </RadioGroup>

        {mode === "allowlist" ? (
          <div className="mt-4 max-w-4xl overflow-hidden rounded-md border border-border">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/30 px-3 py-2">
              <span className="text-xs text-muted-foreground">
                {t("selectedToolCount", { count: selected.size })}
              </span>
              <div className="flex items-center gap-3">
                {entries.length > 0 ? (
                  <Button
                    type="button"
                    onClick={() => {
                      setSelected(
                        new Set(
                          entries
                            .filter((tool) => tool.available)
                            .map((tool) => tool.name),
                        ),
                      );
                      setRevision((current) => current + 1);
                    }}
                    variant="ghost"
                    size="sm"
                  >
                    {t("selectAllTools")}
                  </Button>
                ) : null}
                {selected.size > 0 ? (
                  <Button
                    type="button"
                    onClick={() => {
                      setSelected(new Set());
                      setRevision((current) => current + 1);
                    }}
                    variant="ghost"
                    size="sm"
                  >
                    {t("clearToolSelection")}
                  </Button>
                ) : null}
              </div>
            </div>

            {entries.length > 0 ? (
              <ul className="max-h-80 divide-y divide-border overflow-y-auto">
                {entries.map((tool) => (
                  <li key={tool.name}>
                    <div className="flex cursor-pointer items-start gap-3 px-3 py-3 hover:bg-muted/30">
                      <FormCheckbox
                        name="toolName"
                        value={tool.name}
                        checked={selected.has(tool.name)}
                        onCheckedChange={() => toggleTool(tool.name)}
                        label={tool.name}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-2">
                          {!tool.available ? (
                            <AnimatedBadge
                              status="neutral"
                              size="sm"
                              showIcon={false}
                            >
                              {t("currentlyUnavailable")}
                            </AnimatedBadge>
                          ) : null}
                        </span>
                        {tool.description ? (
                          <span className="mt-1 line-clamp-2 block text-xs leading-5 text-muted-foreground">
                            {tool.description}
                          </span>
                        ) : null}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                {running ? t("mcpReportedNoTools") : t("startMcpToSelectTools")}
              </p>
            )}
          </div>
        ) : (
          <p className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
            <CheckSquare2 className="size-3.5" />
            {t("futureToolsAutomaticallyExposed")}
          </p>
        )}
      </fieldset>

      <div className="mt-4 flex items-start gap-3 rounded-md border border-border bg-muted p-3">
        <FormCheckbox
          name="publicInvocable"
          defaultChecked={initialPublicInvocable}
          disabled={isPending || mode !== "allowlist" || selected.size === 0}
          label={t("publicAgentInvocable")}
        />
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-(--color-warning) dark:text-(--color-warning)" />
        <span className="min-w-0">
          <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
            {t("publicAgentInvocableHelp")}
          </span>
        </span>
      </div>

      <div className="mt-3 min-h-5">
        {error ? (
          <p
            className="text-sm text-destructive dark:text-destructive"
            role="alert"
          >
            {error}
          </p>
        ) : state.savedAt && state.revision === revision ? (
          <p role="status">
            <AnimatedBadge status="success">
              {t("toolExposureSaved")}
            </AnimatedBadge>
          </p>
        ) : null}
      </div>
    </form>
  );
}
