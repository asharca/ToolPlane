"use client";

import { type ReactNode, useState } from "react";
import { useTranslations } from "next-intl";
import {
  AppWindow,
  Braces,
  Brain,
  Bug,
  FileText,
  GitFork,
  Globe,
  History,
  ListTodo,
  SquareTerminal,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/motion/button/base";
import { Switch } from "@/components/motion/switch";
import {
  AGENT_BUILTIN_FEATURES,
  type AgentBuiltinFeatureId,
  agentOptionalBuiltinTool,
  agentRuntimeBuiltinTools,
  isExecutableAgentRuntimeKind,
} from "@/lib/agents/runtime-kind";

const FEATURE_ICONS: Record<AgentBuiltinFeatureId, LucideIcon> = {
  files: FileText,
  shell: SquareTerminal,
  todo: ListTodo,
  web: Globe,
  browser: AppWindow,
  memory: Brain,
  subtasks: GitFork,
  codeRun: Braces,
  codeIntel: Bug,
  rewind: History,
};

export type BuiltinToolSelection = {
  disabledTools: ReadonlySet<string>;
  enabledOptionalTools: ReadonlySet<string>;
};

function toolEnabled(tool: string, selection: BuiltinToolSelection) {
  return agentOptionalBuiltinTool(tool)
    ? selection.enabledOptionalTools.has(tool)
    : !selection.disabledTools.has(tool);
}

/** Form fields carrying the tool-level selection the server persists. */
export function AgentBuiltinFeatureInputs({
  runtimeKind,
  disabledTools,
  enabledOptionalTools,
}: BuiltinToolSelection & { runtimeKind: string }) {
  if (!isExecutableAgentRuntimeKind(runtimeKind)) return null;
  return (
    <>
      <input
        type="hidden"
        name="optionalBuiltinTools"
        value={JSON.stringify([...enabledOptionalTools].sort())}
      />
      {[...disabledTools].map((tool) => (
        <input
          key={tool}
          type="hidden"
          name="disabledBuiltinTool"
          value={tool}
        />
      ))}
    </>
  );
}

export function AgentBuiltinFeatures({
  runtimeKind,
  disabledTools,
  enabledOptionalTools,
  onChange,
  disabled = false,
  memoryManager,
  memoryManagerOpen = false,
}: BuiltinToolSelection & {
  runtimeKind: string;
  onChange: (next: {
    disabledTools: Set<string>;
    enabledOptionalTools: Set<string>;
  }) => void;
  disabled?: boolean;
  /** Rendered below the memory row on request; omit where no Agent exists yet. */
  memoryManager?: ReactNode;
  memoryManagerOpen?: boolean;
}) {
  const t = useTranslations("console.agents.builtinFeatures");
  const [managingMemory, setManagingMemory] = useState(memoryManagerOpen);
  if (!isExecutableAgentRuntimeKind(runtimeKind)) return null;
  const defaults = new Set(agentRuntimeBuiltinTools(runtimeKind));
  const features = AGENT_BUILTIN_FEATURES.filter((feature) =>
    feature.tools.every(
      (tool) => defaults.has(tool) || agentOptionalBuiltinTool(tool),
    ),
  );
  const selection = { disabledTools, enabledOptionalTools };

  function toggle(tools: readonly string[], enabled: boolean) {
    const nextDisabled = new Set(disabledTools);
    const nextOptional = new Set(enabledOptionalTools);
    for (const tool of tools) {
      if (agentOptionalBuiltinTool(tool)) {
        if (enabled) nextOptional.add(tool);
        else nextOptional.delete(tool);
      } else if (enabled) nextDisabled.delete(tool);
      else nextDisabled.add(tool);
    }
    onChange({
      disabledTools: nextDisabled,
      enabledOptionalTools: nextOptional,
    });
  }

  return (
    <ul className="m-0 list-none divide-y divide-border/60 overflow-hidden rounded-xl border border-border/60 p-0">
      {features.map((feature) => {
        const Icon = FEATURE_ICONS[feature.id];
        const enabled = feature.tools.every((tool) =>
          toolEnabled(tool, selection),
        );
        const name = t(`${feature.id}.name`);
        const memory = feature.id === "memory" && memoryManager;
        return (
          <li key={feature.id} className="min-w-0">
            <div className="flex min-w-0 items-center gap-3 px-4 py-3">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted">
                <Icon className="size-4 text-muted-foreground" aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground">{name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {t(`${feature.id}.description`)}
                </p>
              </div>
              {memory ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-expanded={managingMemory}
                  onClick={() => setManagingMemory((open) => !open)}
                >
                  {t("manageMemories")}
                </Button>
              ) : null}
              <Switch
                checked={enabled}
                disabled={disabled}
                ariaLabel={name}
                onCheckedChange={(next) => toggle(feature.tools, next)}
              />
            </div>
            {memory && managingMemory ? (
              <div className="border-t border-border/60">{memoryManager}</div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
