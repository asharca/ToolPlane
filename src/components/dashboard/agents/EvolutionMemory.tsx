"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/motion/button";
import { FormCheckbox } from "@/components/ui/FormCheckbox";
import type {
  EvolutionScope,
  PlaybookDto,
} from "@/lib/agents/evolution/contracts";
import {
  Empty,
  Field,
  inputClass,
  RecordCard,
  Section,
  type Mutation,
} from "./evolution-ui";

const MEMORY_ORDER: Record<PlaybookDto["status"], number> = {
  pending: 0,
  approved: 1,
  rejected: 2,
  archived: 3,
};

export function EvolutionMemory({
  entries,
  busy,
  canReview,
  mutate,
}: {
  entries: PlaybookDto[];
  busy: boolean;
  canReview: boolean;
  mutate: Mutation;
}) {
  const t = useTranslations("console.evolution");
  const [content, setContent] = useState("");
  const [kind, setKind] = useState<EvolutionScope["kind"]>("agent");
  const [scopeId, setScopeId] = useState("");
  const [editing, setEditing] = useState<PlaybookDto | null>(null);
  const [mergeIds, setMergeIds] = useState<string[]>([]);
  const sorted = useMemo(
    () =>
      [...entries].sort(
        (a, b) => MEMORY_ORDER[a.status] - MEMORY_ORDER[b.status],
      ),
    [entries],
  );
  const mergeEntries = entries.filter((entry) => mergeIds.includes(entry.id));
  const sameScope = mergeEntries.every(
    (entry) =>
      JSON.stringify(entry.scope) === JSON.stringify(mergeEntries[0]?.scope),
  );
  function reset() {
    setEditing(null);
    setContent("");
    setMergeIds([]);
  }
  async function save() {
    const scope: EvolutionScope =
      kind === "agent"
        ? { kind }
        : kind === "conversation"
          ? { kind, conversationId: scopeId }
          : { kind, taskId: scopeId };
    const changed = editing
      ? await mutate("playbook", "PATCH", {
          id: editing.id,
          expectedVersion: editing.version,
          content,
          ...(mergeIds.length > 1
            ? { mergeIds: mergeIds.filter((id) => id !== editing.id) }
            : {}),
        })
      : await mutate("playbook", "POST", { content, scope });
    if (changed) reset();
  }
  function edit(entry: PlaybookDto) {
    setEditing(entry);
    setContent(entry.content);
    setKind(entry.scope.kind);
    setScopeId(
      entry.scope.kind === "conversation"
        ? entry.scope.conversationId
        : entry.scope.kind === "task"
          ? entry.scope.taskId
          : "",
    );
  }
  return (
    <div className="space-y-6">
      <Section title={editing ? t("editMemory") : t("newMemory")}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <fieldset className="min-w-0 space-y-3" disabled={busy || !canReview}>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t("scope")}>
                <select
                  className={inputClass}
                  disabled={Boolean(editing)}
                  value={kind}
                  onChange={(event) =>
                    setKind(event.target.value as EvolutionScope["kind"])
                  }
                >
                  {(["agent", "conversation", "task"] as const).map((value) => (
                    <option key={value} value={value}>
                      {t(`scopes.${value}`)}
                    </option>
                  ))}
                </select>
              </Field>
              {kind !== "agent" ? (
                <Field
                  label={
                    kind === "conversation" ? t("conversationId") : t("taskId")
                  }
                >
                  <input
                    className={inputClass}
                    required
                    disabled={Boolean(editing)}
                    value={scopeId}
                    onChange={(event) => setScopeId(event.target.value)}
                  />
                </Field>
              ) : null}
            </div>
            <Field
              label={t("memoryContent")}
              help={editing ? t("memoryEditHelp") : undefined}
            >
              <textarea
                className={inputClass}
                required
                rows={4}
                maxLength={20000}
                value={content}
                onChange={(event) => setContent(event.target.value)}
              />
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button type="submit">
                {editing ? t("save") : t("submitMemory")}
              </Button>
              {editing ? (
                <Button type="button" variant="secondary" onClick={reset}>
                  {t("cancel")}
                </Button>
              ) : null}
            </div>
          </fieldset>
        </form>
      </Section>
      <Section title={t("steps.memory")}>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={
              busy || !canReview || mergeEntries.length < 2 || !sameScope
            }
            onClick={() => {
              const first = mergeEntries[0];
              if (first) edit(first);
            }}
          >
            {t("mergeMemory")}
          </Button>
          <p className="text-xs text-muted-foreground">{t("mergeHelp")}</p>
        </div>
        <Empty count={sorted.length} />
        {sorted.map((item) => (
          <RecordCard
            key={item.id}
            title={`${t(`status.${item.status}`)} · ${t(`scopeTags.${item.scope.kind}`)}`}
            meta={
              item.scope.kind === "conversation"
                ? `${t("conversationId")}: ${item.scope.conversationId}`
                : item.scope.kind === "task"
                  ? `${t("taskId")}: ${item.scope.taskId}`
                  : undefined
            }
          >
            <p className="whitespace-pre-wrap break-words text-sm">
              {item.content}
            </p>
            {item.status !== "archived" ? (
              <div className="flex flex-wrap items-center gap-2">
                {item.status === "pending" ? (
                  <>
                    <Button
                      type="button"
                      size="sm"
                      disabled={busy || !canReview}
                      onClick={() =>
                        void mutate("playbook", "PATCH", {
                          id: item.id,
                          status: "approved",
                          expectedVersion: item.version,
                        })
                      }
                    >
                      {t("approveMemory")}
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      disabled={busy || !canReview}
                      onClick={() =>
                        void mutate("playbook", "PATCH", {
                          id: item.id,
                          status: "rejected",
                          expectedVersion: item.version,
                        })
                      }
                    >
                      {t("reject")}
                    </Button>
                  </>
                ) : null}
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={busy || !canReview}
                  onClick={() => {
                    setMergeIds([]);
                    edit(item);
                  }}
                >
                  {t("editMemory")}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy || !canReview}
                  onClick={() =>
                    void mutate("playbook", "PATCH", {
                      id: item.id,
                      status: "archived",
                      expectedVersion: item.version,
                    })
                  }
                >
                  {t("archive")}
                </Button>
                <FormCheckbox
                  disabled={busy || !canReview || Boolean(editing)}
                  checked={mergeIds.includes(item.id)}
                  onCheckedChange={(checked) =>
                    setMergeIds((previous) =>
                      checked
                        ? [...previous, item.id]
                        : previous.filter((id) => id !== item.id),
                    )
                  }
                  label={t("selectMemory")}
                />
              </div>
            ) : null}
          </RecordCard>
        ))}
      </Section>
    </div>
  );
}
