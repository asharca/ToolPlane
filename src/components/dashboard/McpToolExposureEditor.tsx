"use client";

import { useActionState, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { ChevronRight, Save, Wrench } from "lucide-react";
import { AnimatedBadge } from "@/components/motion/animated-badge";
import { BouncyAccordion } from "@/components/motion/bouncy-accordion";
import { Button } from "@/components/motion/button";
import { Switch } from "@/components/motion/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/motion/tabs";
import { FormCheckbox } from "@/components/ui/FormCheckbox";
import {
  updateMcpToolExposureAction,
  type McpToolExposureActionState,
} from "@/lib/workspace/actions";
import { notify } from "./Toaster";
import {
  McpConnectedChips,
  type McpConnectedObject,
} from "./McpConnectedChips";

type Mode = "all" | "allowlist";

type ToolSummary = {
  name: string;
  title?: string;
  description?: string;
};

function signature(
  mode: Mode,
  selected: Iterable<string>,
  publicInvocable: boolean,
) {
  return JSON.stringify([
    mode,
    mode === "allowlist" ? [...selected].sort() : [],
    publicInvocable,
  ]);
}

/**
 * Deployment-level tool access: the single filter applied to every Agent and
 * Assistant connected to this MCP.
 */
export function McpToolExposureEditor({
  workspace,
  deploymentId,
  tools,
  initialMode,
  initialAllowedTools,
  initialPublicInvocable = false,
  editable,
  connected,
  toolBasePath,
}: {
  workspace: string;
  deploymentId: string;
  tools: ToolSummary[];
  initialMode: Mode;
  initialAllowedTools: string[];
  initialPublicInvocable?: boolean;
  editable: boolean;
  connected: McpConnectedObject[];
  toolBasePath: string;
}) {
  const t = useTranslations("console.mcp");
  const [saved, setSaved] = useState(() =>
    signature(initialMode, initialAllowedTools, initialPublicInvocable),
  );
  const [state, formAction, isPending] = useActionState<
    McpToolExposureActionState,
    FormData
  >(async (previous, formData) => {
    const result = await updateMcpToolExposureAction(previous, formData);
    if (result.savedAt) {
      setSaved(
        signature(
          formData.get("mode") === "allowlist" ? "allowlist" : "all",
          formData.getAll("toolName").map(String),
          formData.get("publicInvocable") === "on",
        ),
      );
      notify(t("toolExposureSaved"));
    }
    return result;
  }, {});
  const [mode, setMode] = useState<Mode>(initialMode);
  const [selected, setSelected] = useState(
    () =>
      new Set(
        initialMode === "all"
          ? tools.map((tool) => tool.name)
          : initialAllowedTools,
      ),
  );
  const [publicInvocable, setPublicInvocable] = useState(
    initialPublicInvocable,
  );

  const entries = useMemo(() => {
    const byName = new Map(
      tools.map((tool) => [tool.name, { ...tool, available: true }]),
    );
    if (mode === "allowlist") {
      for (const name of selected) {
        if (!byName.has(name)) byName.set(name, { name, available: false });
      }
    }
    return [...byName.values()];
  }, [mode, selected, tools]);

  const enabledCount =
    mode === "all"
      ? tools.length
      : tools.filter((tool) => selected.has(tool.name)).length;
  const publicAllowed = mode === "allowlist" && selected.size > 0;
  const effectivePublic = publicInvocable && publicAllowed;
  const current = signature(mode, selected, effectivePublic);
  const dirty = current !== saved;

  const selectMode = (next: Mode) => {
    if (next === mode) return;
    if (next === "allowlist")
      setSelected(new Set(tools.map((tool) => tool.name)));
    setMode(next);
  };
  const toggleTool = (name: string) => {
    if (mode === "all") {
      setSelected(
        new Set(
          tools
            .map((tool) => tool.name)
            .filter((toolName) => toolName !== name),
        ),
      );
      setMode("allowlist");
      return;
    }
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const locked = !editable || isPending;

  return (
    <form
      action={formAction}
      className="min-w-0 rounded-xl border border-border bg-card"
    >
      <input type="hidden" name="workspace" value={workspace} />
      <input type="hidden" name="deploymentId" value={deploymentId} />
      <input type="hidden" name="mode" value={mode} />
      {mode === "allowlist"
        ? [...selected].map((name) => (
            <input key={name} type="hidden" name="toolName" value={name} />
          ))
        : null}
      {effectivePublic ? (
        <input type="hidden" name="publicInvocable" value="on" />
      ) : null}

      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <Wrench className="size-4 shrink-0 text-muted-foreground" />
          <h2 className="text-sm font-semibold text-foreground">
            {t("toolAccess")}
          </h2>
          <span
            title={t("toolsExposedSummary", {
              count: enabledCount,
              total: tools.length,
            })}
            className="rounded-full bg-muted px-2 py-0.5 font-mono text-xs tabular-nums text-muted-foreground"
          >
            {enabledCount}/{tools.length}
          </span>
        </div>
        {editable ? (
          <Tabs
            variant="segment"
            value={mode}
            onValueChange={(value) => selectMode(value as Mode)}
          >
            <TabsList aria-label={t("toolAccess")} className="bg-muted/60">
              <TabsTrigger
                value="all"
                disabled={isPending}
                className="px-3 py-1 text-xs"
              >
                {t("allTools")}
              </TabsTrigger>
              <TabsTrigger
                value="allowlist"
                disabled={isPending}
                className="px-3 py-1 text-xs"
              >
                {t("selectedTools")}
              </TabsTrigger>
            </TabsList>
          </Tabs>
        ) : (
          <span className="text-xs font-medium text-muted-foreground">
            {mode === "all" ? t("allTools") : t("selectedTools")}
          </span>
        )}
      </header>

      {connected.length ? (
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-5 py-3">
          <span className="text-xs text-muted-foreground">
            {t("connectedTo")}
          </span>
          <McpConnectedChips objects={connected} />
        </div>
      ) : null}

      {mode === "all" ? (
        <p className="border-b border-border bg-muted/25 px-5 py-2 text-xs text-muted-foreground">
          {t("allCurrentAndFutureTools")}
        </p>
      ) : editable && entries.length ? (
        <div className="flex items-center justify-end gap-1 border-b border-border bg-muted/25 px-3 py-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={isPending}
            onClick={() => setSelected(new Set(tools.map((tool) => tool.name)))}
          >
            {t("selectAllTools")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={isPending || selected.size === 0}
            onClick={() => setSelected(new Set())}
          >
            {t("clearToolSelection")}
          </Button>
        </div>
      ) : null}

      {entries.length ? (
        <ul className="divide-y divide-border">
          {entries.map((tool) => {
            const enabled = mode === "all" || selected.has(tool.name);
            const description = tool.description?.trim();
            const title =
              tool.title && tool.title !== tool.name ? tool.title : null;
            return (
              <li
                key={tool.name}
                className="flex min-w-0 items-center gap-4 px-5 py-2.5"
              >
                <Switch
                  checked={enabled}
                  onCheckedChange={() => toggleTool(tool.name)}
                  disabled={locked}
                  ariaLabel={tool.name}
                />
                {tool.available ? (
                  <Link
                    href={`${toolBasePath}/${encodeURIComponent(tool.name)}`}
                    className="group flex min-w-0 flex-1 items-center gap-3 rounded-lg py-1 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="flex min-w-0 items-baseline gap-2">
                        <code
                          className={`truncate font-mono text-sm font-medium ${enabled ? "text-foreground" : "text-muted-foreground"}`}
                        >
                          {tool.name}
                        </code>
                        {title ? (
                          <span className="hidden truncate text-xs text-muted-foreground sm:inline">
                            {title}
                          </span>
                        ) : null}
                      </span>
                      {description ? (
                        <span
                          title={description}
                          className="mt-0.5 block truncate text-xs text-muted-foreground"
                        >
                          {description}
                        </span>
                      ) : null}
                    </span>
                    <ChevronRight className="size-4 shrink-0 text-muted-foreground opacity-40 transition-opacity group-hover:opacity-100" />
                  </Link>
                ) : (
                  <span className="flex min-w-0 flex-1 items-center gap-2 py-1">
                    <code className="truncate font-mono text-sm text-muted-foreground">
                      {tool.name}
                    </code>
                    <AnimatedBadge status="neutral" size="sm" showIcon={false}>
                      {t("currentlyUnavailable")}
                    </AnimatedBadge>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="px-5 py-10 text-center text-sm text-muted-foreground">
          {editable ? t("mcpReportedNoTools") : t("startMcpToSelectTools")}
        </p>
      )}

      {editable ? (
        <>
          <BouncyAccordion
            defaultValue={initialPublicInvocable ? "advanced" : null}
            className="border-t border-border"
            classNames={{
              item: "bg-transparent",
              trigger: "min-h-11 px-5",
              title: "text-xs font-medium text-muted-foreground",
              description: "text-sm",
            }}
            items={[
              {
                id: "advanced",
                title: t("advanced"),
                description: (
                  <div className="space-y-1.5">
                    <FormCheckbox
                      checked={effectivePublic}
                      onCheckedChange={setPublicInvocable}
                      disabled={isPending || !publicAllowed}
                      label={t("publicAgentInvocable")}
                    />
                    <p className="pl-8 text-xs leading-5 text-muted-foreground">
                      {t("publicAgentInvocableHelp")}
                    </p>
                  </div>
                ),
              },
            ]}
          />
          <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-end gap-3 rounded-b-xl border-t border-border bg-card/95 px-5 py-3 backdrop-blur">
            {state.error ? (
              <p role="alert" className="mr-auto text-sm text-destructive">
                {t(state.error)}
              </p>
            ) : null}
            <Button
              type="submit"
              disabled={!dirty || isPending}
              variant="primary"
              size="sm"
            >
              <Save className="size-3.5" />
              {isPending ? t("savingToolExposure") : t("saveToolExposure")}
            </Button>
          </div>
        </>
      ) : null}
    </form>
  );
}
