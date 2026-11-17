"use client";

import { useEffect, useId, useState } from "react";
import { useTranslations } from "next-intl";
import { ArrowDown, ArrowUp, ListFilter, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/motion/button/base";
import { Input } from "@/components/motion/input";
import { FormSelect } from "@/components/ui/FormSelect";
import {
  StreamRulesSchema,
  streamRuleValidationCode,
  type StreamRule,
} from "@/lib/agents/stream-rules";
import { DashboardEmptyState } from "../DashboardUI";
import { DialogField } from "../dialog";

export type StreamRulesDraft = {
  rules: StreamRule[] | null;
  dirty: boolean;
  save: () => Promise<void>;
  setRules: (rules: StreamRule[]) => void;
  loadError: string;
  reload: () => void;
};
export function useStreamRulesDraft(
  slug: string,
  agentId: string,
  enabled: boolean,
) {
  const t = useTranslations("console.agents.streamRules");
  const [rules, setRules] = useState<StreamRule[] | null>(null);
  const [saved, setSaved] = useState<StreamRule[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const url = `/api/v1/agents/${encodeURIComponent(agentId)}/stream-rules`;
  const dirty = JSON.stringify(rules) !== JSON.stringify(saved);
  const errorText = (code: string) =>
    t.has(`errors.${code}`)
      ? t(`errors.${code}`)
      : t("errors.STREAM_RULES_SAVE_FAILED");

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setRules(null);
    setSaved(null);
    setLoadError("");
    void (async () => {
      try {
        const response = await fetch(
          `${url}?workspace=${encodeURIComponent(slug)}`,
          {
            cache: loadAttempt > 0 ? "reload" : "no-store",
            signal: controller.signal,
          },
        );
        const body = await response.json();
        if (!response.ok) {
          if (!controller.signal.aborted)
            setLoadError(body.error ?? "loadFailed");
          return;
        }
        const parsed = StreamRulesSchema.safeParse(body.streamRules);
        if (!parsed.success) {
          if (!controller.signal.aborted) setLoadError("loadFailed");
          return;
        }
        if (!controller.signal.aborted) {
          setRules(parsed.data);
          setSaved(parsed.data);
        }
      } catch {
        if (!controller.signal.aborted) setLoadError("loadFailed");
      }
    })();
    return () => controller.abort();
  }, [enabled, slug, url, loadAttempt]);

  async function save() {
    if (!dirty || rules === null) return;
    const parsed = StreamRulesSchema.safeParse(rules);
    if (!parsed.success)
      throw new Error(errorText(streamRuleValidationCode(parsed.error)));
    let response: Response;
    let body: { error?: string; streamRules?: unknown };
    try {
      response = await fetch(url, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspace: slug, streamRules: parsed.data }),
      });
      body = await response.json();
    } catch {
      throw new Error(errorText("STREAM_RULES_SAVE_FAILED"));
    }
    if (!response.ok)
      throw new Error(errorText(body.error ?? "STREAM_RULES_SAVE_FAILED"));
    const result = StreamRulesSchema.safeParse(body.streamRules);
    if (!result.success) throw new Error(errorText("STREAM_RULES_SAVE_FAILED"));
    setRules(result.data);
    setSaved(result.data);
  }

  return {
    rules,
    dirty,
    save,
    setRules,
    loadError: loadError ? errorText(loadError) : "",
    reload: () => setLoadAttempt((attempt) => attempt + 1),
  };
}

export function AgentStreamRulesEditor({
  draft,
  disabled,
  onChange,
}: {
  draft: StreamRulesDraft;
  disabled: boolean;
  onChange: () => void;
}) {
  const t = useTranslations("console.agents.streamRules");
  const id = useId();
  const rules = draft.rules;
  const update = (next: StreamRule[]) => {
    draft.setRules(next);
    onChange();
  };
  if (draft.loadError)
    return (
      <div className="space-y-3">
        <p role="alert" className="text-sm text-destructive">
          {draft.loadError}
        </p>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          onClick={draft.reload}
        >
          {t("retry")}
        </Button>
      </div>
    );
  if (!rules)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {t("loading")}
      </p>
    );

  const addButton = (
    <Button
      type="button"
      variant="outline"
      disabled={disabled || rules.length >= 50}
      onClick={() =>
        update([
          ...rules,
          {
            id: crypto.randomUUID(),
            name: "",
            target: "assistant_text",
            pattern: "",
            action: "remind",
            message: "",
          },
        ])
      }
    >
      <Plus aria-hidden="true" className="size-4" />
      {t("add")}
    </Button>
  );

  return (
    <div className="space-y-4">
      {rules.length ? (
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-muted-foreground">
            {t("count", { count: rules.length })}
          </span>
          {addButton}
        </div>
      ) : (
        <DashboardEmptyState
          icon={ListFilter}
          title={t("emptyTitle")}
          description={t("emptyDescription")}
          actions={addButton}
          className="rounded-xl bg-muted/30"
        />
      )}
      {rules.map((rule, index) => {
        const prefix = `${id}-${rule.id}`;
        const patch = (change: Partial<StreamRule>) =>
          update(
            rules.map((item) =>
              item.id === rule.id ? { ...item, ...change } : item,
            ),
          );
        const move = (offset: number) => {
          const next = [...rules];
          [next[index], next[index + offset]] = [
            next[index + offset],
            next[index],
          ];
          update(next);
        };
        return (
          <fieldset
            key={rule.id}
            disabled={disabled}
            className="min-w-0 space-y-4 rounded-lg border border-border p-4"
          >
            <legend className="px-1 text-sm font-medium">
              {t("rule", { number: index + 1 })}
            </legend>
            <div className="flex justify-end gap-1">
              <Button
                type="button"
                variant="ghost"
                aria-label={t("moveUp")}
                title={t("moveUp")}
                disabled={disabled || index === 0}
                onClick={() => move(-1)}
              >
                <ArrowUp aria-hidden="true" className="size-4" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                aria-label={t("moveDown")}
                title={t("moveDown")}
                disabled={disabled || index === rules.length - 1}
                onClick={() => move(1)}
              >
                <ArrowDown aria-hidden="true" className="size-4" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                aria-label={t("remove")}
                title={t("remove")}
                disabled={disabled}
                onClick={() =>
                  update(rules.filter((item) => item.id !== rule.id))
                }
              >
                <Trash2 aria-hidden="true" className="size-4" />
              </Button>
            </div>
            <DialogField label={t("name")} htmlFor={`${prefix}-name`}>
              <Input
                id={`${prefix}-name`}
                value={rule.name}
                maxLength={240}
                onChange={(value) => patch({ name: value })}
              />
            </DialogField>
            <div className="grid gap-4 sm:grid-cols-2">
              <DialogField label={t("target")} htmlFor={`${prefix}-target`}>
                <FormSelect
                  id={`${prefix}-target`}
                  label={t("target")}
                  disabled={disabled}
                  value={rule.target}
                  options={[
                    {
                      value: "assistant_text",
                      label: t("targets.assistant_text"),
                    },
                    { value: "tool_call", label: t("targets.tool_call") },
                  ]}
                  onValueChange={(value) => {
                    if (value === "assistant_text") {
                      const { toolName: _toolName, ...textRule } = rule;
                      update(
                        rules.map((item) =>
                          item.id === rule.id
                            ? {
                                ...textRule,
                                target: "assistant_text",
                                action: "remind",
                              }
                            : item,
                        ),
                      );
                    } else patch({ target: "tool_call" });
                  }}
                />
              </DialogField>
              <DialogField label={t("action")} htmlFor={`${prefix}-action`}>
                <FormSelect
                  id={`${prefix}-action`}
                  label={t("action")}
                  disabled={disabled || rule.target === "assistant_text"}
                  value={rule.action}
                  options={[
                    { value: "remind", label: t("actions.remind") },
                    {
                      value: "block",
                      label: t("actions.block"),
                      disabled: rule.target === "assistant_text",
                    },
                  ]}
                  onValueChange={(value) =>
                    patch({ action: value as StreamRule["action"] })
                  }
                />
              </DialogField>
            </div>
            <DialogField label={t("toolName")} htmlFor={`${prefix}-tool`}>
              <Input
                id={`${prefix}-tool`}
                disabled={disabled || rule.target !== "tool_call"}
                value={rule.toolName ?? ""}
                maxLength={240}
                placeholder={t("anyTool")}
                onChange={(value) => {
                  const { toolName: _toolName, ...next } = rule;
                  update(
                    rules.map((item) =>
                      item.id === rule.id
                        ? {
                            ...next,
                            ...(value.trim() ? { toolName: value } : {}),
                          }
                        : item,
                    ),
                  );
                }}
              />
            </DialogField>
            <DialogField label={t("pattern")} htmlFor={`${prefix}-pattern`}>
              <Input
                id={`${prefix}-pattern`}
                value={rule.pattern}
                maxLength={500}
                className="font-mono"
                onChange={(value) => patch({ pattern: value })}
              />
            </DialogField>
            <DialogField label={t("message")} htmlFor={`${prefix}-message`}>
              <textarea
                id={`${prefix}-message`}
                value={rule.message}
                maxLength={2000}
                rows={3}
                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                onChange={(event) => patch({ message: event.target.value })}
              />
            </DialogField>
          </fieldset>
        );
      })}
    </div>
  );
}
