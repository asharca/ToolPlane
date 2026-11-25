"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useTranslations } from "next-intl";
import { z } from "zod";
import { ApprovalCard } from "@/components/agents/approval-card";
import { useAgentUiLabels } from "../agent-ui-labels";
import { TodoList } from "@/components/agents/todo-list";
import { Input } from "@/components/motion/input";
import { Button } from "@/components/motion/button";
import { notify } from "@/components/dashboard/Toaster";
import {
  SubagentSourceSchema,
  SubagentSourceLabel,
  subagentSourceKey,
  SubagentActivitySchema,
  SubagentActivity,
} from "../agents/SubagentActivity";
import { HookActivity, HookActivitySchema } from "../agents/HookActivity";
import {
  ToolApprovalCardSchema,
  ToolApprovalRequest,
  type ToolApprovalDecision,
} from "./ToolApprovalRequest";

const base = {
  type: z.literal("extension_ui_request"),
  id: z.string(),
  source: SubagentSourceSchema.optional(),
};
export const NativeDialogSchema = z.discriminatedUnion("method", [
  z.object({
    ...base,
    method: z.literal("select"),
    title: z.string(),
    options: z.array(z.string()),
    timeout: z.number().optional(),
  }),
  z.object({
    ...base,
    method: z.literal("confirm"),
    title: z.string(),
    message: z.string(),
    timeout: z.number().optional(),
  }),
  z.object({
    ...base,
    method: z.literal("takeover"),
    reason: z.enum([
      "captcha",
      "sso",
      "passkey",
      "qr",
      "payment_verification",
      "human_required",
    ]),
    title: z.string(),
    message: z.string(),
    timeout: z.number().optional(),
  }),
  z.object({
    ...base,
    method: z.literal("input"),
    title: z.string(),
    placeholder: z.string().optional(),
    timeout: z.number().optional(),
    secret: z.boolean().optional(),
  }),
  z.object({
    ...base,
    method: z.literal("editor"),
    title: z.string(),
    prefill: z.string().optional(),
  }),
  z.object({
    ...base,
    method: z.literal("ask"),
    title: z.string(),
    questions: z.array(
      z.object({
        id: z.string(),
        question: z.string(),
        options: z.array(
          z.object({ label: z.string(), description: z.string().optional() }),
        ),
        multi: z.boolean().optional(),
        recommended: z.number().optional(),
      }),
    ),
  }),
]);
const NativeEventSchema = z.discriminatedUnion("method", [
  z.object({
    ...base,
    method: z.literal("notify"),
    message: z.string(),
    notifyType: z.enum(["info", "warning", "error"]).optional(),
  }),
  z.object({
    ...base,
    method: z.literal("setStatus"),
    statusKey: z.string(),
    statusText: z.string().optional(),
  }),
  z.object({
    ...base,
    method: z.literal("setWidget"),
    widgetKey: z.string(),
    widgetLines: z.array(z.string()).optional(),
    widgetPlacement: z.enum(["aboveEditor", "belowEditor"]).optional(),
  }),
  z.object({ ...base, method: z.literal("setTitle"), title: z.string() }),
  z.object({ ...base, method: z.literal("set_editor_text"), text: z.string() }),
]);
export const NativeProjectionSchema = z.object({
  activities: z.array(SubagentActivitySchema).default([]),
  hooks: z.array(HookActivitySchema).default([]),
  toolApprovals: z.array(ToolApprovalCardSchema).default([]),
  uiRequests: z.array(NativeDialogSchema),
  todos: z.array(
    z.object({
      id: z.number(),
      text: z.string(),
      done: z.boolean(),
      status: z
        .enum(["pending", "in_progress", "completed", "abandoned", "blocked"])
        .optional(),
      phase: z.string().optional(),
      blocker: z.string().optional(),
      source: SubagentSourceSchema.optional(),
    }),
  ),
  uiEvents: z.array(NativeEventSchema),
});
export type NativeProjection = z.infer<typeof NativeProjectionSchema>;
export type NativeResponse = {
  type: "extension_ui_response";
  id: string;
  value?: string;
  confirmed?: boolean;
  cancelled?: boolean;
  answers?: Array<{
    id: string;
    selectedOptions: string[];
    customInput?: string;
  }>;
  source?: z.infer<typeof SubagentSourceSchema>;
};

type Dialog = z.infer<typeof NativeDialogSchema>;

function NativeDialog({
  request,
  busy,
  disabled,
  onRespond,
  onOpenScreen,
}: {
  request: Dialog;
  busy: boolean;
  disabled: boolean;
  onRespond: (response: NativeResponse) => void;
  onOpenScreen?: () => void;
}) {
  const t = useTranslations("console.work.nativeUi");
  const ui = useTranslations("console.agentUi");
  const id = useId();
  const [value, setValue] = useState(
    request.method === "editor" ? (request.prefill ?? "") : "",
  );

  return (
    <fieldset
      disabled={disabled || busy}
      className="min-w-0 space-y-2 rounded-xl border border-border/60 bg-muted/40 p-2 [overflow-wrap:anywhere]"
      onKeyDown={(event) => {
        if (disabled || busy) return;
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onRespond({
            type: "extension_ui_response",
            id: request.id,
            cancelled: true,
          });
        } else if (
          event.key === "Enter" &&
          !event.nativeEvent.isComposing &&
          (request.method === "input" ||
            (request.method === "editor" &&
              (event.ctrlKey || event.metaKey))) &&
          (event.target instanceof HTMLInputElement ||
            event.target instanceof HTMLTextAreaElement)
        ) {
          event.preventDefault();
          event.stopPropagation();
          onRespond({ type: "extension_ui_response", id: request.id, value });
        } else if (
          request.method === "select" &&
          event.target instanceof HTMLElement &&
          event.target.getAttribute("role") === "radio" &&
          [
            "ArrowUp",
            "ArrowDown",
            "ArrowLeft",
            "ArrowRight",
            "Home",
            "End",
          ].includes(event.key)
        ) {
          event.preventDefault();
          event.stopPropagation();
          const radios = [
            ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
              '[role="radio"]',
            ),
          ];
          const index = radios.indexOf(event.target as HTMLButtonElement);
          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? radios.length - 1
                : (index +
                    (["ArrowUp", "ArrowLeft"].includes(event.key) ? -1 : 1) +
                    radios.length) %
                  radios.length;
          radios[next]?.focus();
          radios[next]?.click();
        }
      }}
    >
      <legend className="sr-only">
        {request.method === "takeover" ? t("takeover.title") : request.title}
      </legend>
      {request.source ? <SubagentSourceLabel source={request.source} /> : null}
      <ApprovalCard
        className="border-0 bg-transparent p-2 shadow-none"
        title={
          request.method === "takeover" ? t("takeover.title") : request.title
        }
        description={
          request.method === "confirm" || request.method === "takeover"
            ? request.message
            : undefined
        }
        status={busy ? "submitting" : "pending"}
        approveLabel={
          request.method === "takeover"
            ? t("takeover.continue")
            : request.method === "confirm"
              ? t("confirm")
              : t("submit")
        }
        questions={
          request.method === "select"
            ? [
                {
                  id: request.id,
                  title: request.title,
                  options: request.options.map((option, index) => ({
                    value: String(index),
                    label: option,
                  })),
                },
              ]
            : request.method === "ask"
              ? request.questions.map((question) => ({
                  id: question.id,
                  title: question.question,
                  multiple: question.multi,
                  autoAdvance: false,
                  allowCustom: true,
                  customPlaceholder: t("customInput"),
                  description: question.options.some(
                    (option) => option.description,
                  ) ? (
                    <dl className="space-y-2 text-xs">
                      {question.options.map((option) =>
                        option.description ? (
                          <div key={option.label}>
                            <dt className="font-medium">{option.label}</dt>
                            <dd className="text-muted-foreground">
                              {option.description}
                            </dd>
                          </div>
                        ) : null,
                      )}
                    </dl>
                  ) : undefined,
                  options: question.options.map((option, index) => ({
                    value: String(index),
                    label:
                      index === question.recommended
                        ? t("recommendedOption", { label: option.label })
                        : option.label,
                  })),
                }))
              : undefined
        }
        submitLabel={t("submit")}
        rejectLabel={t("decline")}
        cancelLabel={t("cancel")}
        labels={{
          pending: ui("approvalPending"),
          submitting: ui("approvalSubmitting"),
          approved: ui("approvalApproved"),
          rejected: ui("approvalRejected"),
          "changes-requested": ui("approvalChanges"),
          answered: t("submitted"),
          previousQuestion: ui("previousQuestion"),
          nextQuestion: ui("nextQuestion"),
        }}
        onReject={
          request.method === "confirm"
            ? () =>
                onRespond({
                  type: "extension_ui_response",
                  id: request.id,
                  confirmed: false,
                })
            : undefined
        }
        onCancel={() =>
          onRespond({
            type: "extension_ui_response",
            id: request.id,
            ...(request.method === "takeover"
              ? { confirmed: false }
              : { cancelled: true }),
          })
        }
        onSubmit={(answers) => {
          if (request.method === "ask") {
            onRespond({
              type: "extension_ui_response",
              id: request.id,
              answers: request.questions.map((question) => ({
                id: question.id,
                selectedOptions: (answers[question.id]?.selected ?? []).flatMap(
                  (index) => {
                    const option = question.options[Number(index)];
                    return option ? [option.label] : [];
                  },
                ),
                ...(answers[question.id]?.custom?.trim()
                  ? { customInput: answers[question.id].custom }
                  : {}),
              })),
            });
            return;
          }
          if (request.method !== "select") return;
          const selected = answers[request.id]?.selected[0];
          if (selected === undefined) return;
          const option = request.options[Number(selected)];
          if (option !== undefined)
            onRespond({
              type: "extension_ui_response",
              id: request.id,
              value: option,
            });
        }}
        onApprove={() =>
          onRespond(
            request.method === "confirm" || request.method === "takeover"
              ? {
                  type: "extension_ui_response",
                  id: request.id,
                  confirmed: true,
                }
              : { type: "extension_ui_response", id: request.id, value },
          )
        }
      >
        {request.method === "takeover" ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted-foreground">
              {t(`takeover.reasons.${request.reason}`)}
            </span>
            {onOpenScreen ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onOpenScreen}
              >
                {t("takeover.openScreen")}
              </Button>
            ) : null}
          </div>
        ) : null}
        {request.method === "input" ? (
          <Input
            aria-label={request.title}
            type={request.secret ? "password" : "text"}
            autoComplete="off"
            value={value}
            onChange={setValue}
            placeholder={request.placeholder}
            disabled={disabled || busy}
          />
        ) : request.method === "editor" ? (
          <div className="space-y-1.5">
            <label htmlFor={id} className="sr-only">
              {request.title}
            </label>
            <textarea
              id={id}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              disabled={disabled || busy}
              rows={6}
              className="max-h-80 min-h-32 w-full resize-y rounded-xl border border-border bg-background p-3 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
        ) : null}
      </ApprovalCard>
    </fieldset>
  );
}

/** Native runtime projections are read-only; only dialog responses return to the host. */
export function NativeSessionUi({
  projection,
  scope,
  disabled,
  busyId,
  onRespond,
  onSetEditorText,
  belowEditorElement,
  onOpenScreen,
  onTakeoverRequest,
  onTakeoverAnswered,
  onToolApproval,
  onToolApprovalExpire,
  toolApprovalDisabled = disabled,
}: {
  projection: NativeProjection;
  scope: string;
  disabled: boolean;
  busyId: string | null;
  onRespond: (response: NativeResponse) => void;
  onSetEditorText?: (text: string) => void;
  belowEditorElement?: HTMLDivElement | null;
  onOpenScreen?: () => void;
  onTakeoverRequest?: (id: string) => void;
  /** Called before a takeover answer is sent, so the user hands control back first. */
  onTakeoverAnswered?: () => void;
  onToolApproval?: (decision: ToolApprovalDecision) => void;
  onToolApprovalExpire?: (id: string) => void;
  toolApprovalDisabled?: boolean;
}) {
  const t = useTranslations("console.work.nativeUi");
  const agentUi = useAgentUiLabels();
  const [approvalIndex, setApprovalIndex] = useState(0);
  const seen = useRef<{ scope: string; ids: Set<string> }>({
    scope: "",
    ids: new Set(),
  });
  useEffect(() => {
    const storageKey = `toolplane:native-ui:${scope}`;
    if (seen.current.scope !== scope) {
      let ids: string[] = [];
      try {
        const stored: unknown = JSON.parse(
          sessionStorage.getItem(storageKey) ?? "[]",
        );
        if (Array.isArray(stored))
          ids = stored.filter((id): id is string => typeof id === "string");
      } catch {
        // Storage may be unavailable; in-memory deduplication still applies.
      }
      seen.current = { scope, ids: new Set(ids) };
    }
    for (const event of projection.uiEvents) {
      if (seen.current.ids.has(event.id)) continue;
      if (event.method === "set_editor_text" && !onSetEditorText) continue;
      seen.current.ids.add(event.id);
      if (event.method === "notify")
        notify(
          event.source
            ? `${t("source", { name: event.source.subagentName ?? event.source.subagentId })}: ${event.message}`
            : event.message,
          { severity: event.notifyType ?? "info" },
        );
      if (event.method === "set_editor_text" && !event.source)
        onSetEditorText?.(event.text);
    }
    seen.current.ids = new Set(
      projection.uiEvents
        .filter((event) => seen.current.ids.has(event.id))
        .map((event) => event.id),
    );
    try {
      sessionStorage.setItem(storageKey, JSON.stringify([...seen.current.ids]));
    } catch {
      // Notifications and editor updates never depend on storage availability.
    }
  }, [projection.uiEvents, scope, onSetEditorText, t]);

  useEffect(() => {
    if (disabled || !onTakeoverRequest) return;
    for (const request of projection.uiRequests) {
      if (request.method === "takeover") onTakeoverRequest(request.id);
    }
  }, [disabled, projection.uiRequests, onTakeoverRequest]);

  const statuses = new Map<
    string,
    { text?: string; source?: z.infer<typeof SubagentSourceSchema> }
  >();
  const widgets = new Map<
    string,
    {
      lines?: string[];
      placement?: string;
      source?: z.infer<typeof SubagentSourceSchema>;
    }
  >();
  let title: string | undefined;
  let editorText: string | undefined;
  for (const event of projection.uiEvents) {
    if (event.method === "setStatus")
      statuses.set(`${subagentSourceKey(event.source)}:${event.statusKey}`, {
        text: event.statusText,
        source: event.source,
      });
    if (event.method === "setWidget")
      widgets.set(`${subagentSourceKey(event.source)}:${event.widgetKey}`, {
        lines: event.widgetLines,
        placement: event.widgetPlacement,
        source: event.source,
      });
    if (event.method === "setTitle") {
      if (!event.source) title = event.title;
      else
        statuses.set(`${subagentSourceKey(event.source)}:title`, {
          text: event.title,
          source: event.source,
        });
    }
    if (event.method === "set_editor_text" && !event.source)
      editorText = event.text;
  }
  return (
    <div className="min-w-0 space-y-3">
      {projection.hooks.length ? (
        <section className="space-y-2" aria-label={t("hooks.title")}>
          <h4 className="text-sm font-medium">{t("hooks.title")}</h4>
          {projection.hooks.map((hook) => (
            <HookActivity key={hook.id} value={hook} />
          ))}
        </section>
      ) : null}
      {projection.activities.map((activity, index) => (
        <SubagentActivity
          key={`${subagentSourceKey(activity.source)}:${activity.toolCallId ?? index}`}
          value={activity}
        />
      ))}
      {title ? (
        <p className="break-words text-sm font-medium">{title}</p>
      ) : null}
      {[...statuses].map(([key, { text, source }]) =>
        text ? (
          <p
            key={key}
            role="status"
            className="whitespace-pre-wrap break-words text-sm text-muted-foreground"
          >
            {source ? (
              <>
                <SubagentSourceLabel source={source} />
                <br />
              </>
            ) : null}
            {text}
          </p>
        ) : null,
      )}
      {[...widgets].map(([key, widget]) => {
        if (!widget.lines?.length) return null;
        const content = (
          <div
            key={key}
            className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-sm text-muted-foreground"
          >
            {widget.source ? (
              <>
                <SubagentSourceLabel source={widget.source} />
                <br />
              </>
            ) : null}
            {widget.lines.join("\n")}
          </div>
        );
        return widget.placement === "belowEditor" && belowEditorElement
          ? createPortal(content, belowEditorElement, key)
          : content;
      })}
      {[
        ...new Map(
          projection.todos.map((todo) => {
            const phase = todo.phase ?? "";
            return [
              JSON.stringify([subagentSourceKey(todo.source), phase]),
              { phase, source: todo.source },
            ] as const;
          }),
        ).entries(),
      ].map(([key, { phase, source }]) => (
        <TodoList
          key={key}
          labels={agentUi.todoList}
          title={
            source ? (
              <>
                <SubagentSourceLabel source={source} /> · {phase || t("todos")}
              </>
            ) : (
              phase || t("todos")
            )
          }
          items={projection.todos
            .filter(
              (todo) =>
                subagentSourceKey(todo.source) === subagentSourceKey(source) &&
                (todo.phase ?? "") === phase,
            )
            .map((todo) => ({
              id: String(todo.id),
              title: <span title={todo.text}>{todo.text}</span>,
              status:
                todo.status === "in_progress"
                  ? "in-progress"
                  : todo.status === "abandoned"
                    ? "cancelled"
                    : todo.status === "completed" || (!todo.status && todo.done)
                      ? "completed"
                      : "pending",
              detail:
                todo.status || todo.blocker ? (
                  <span className="whitespace-pre-wrap break-words">
                    {todo.status ? t(`todoStatus.${todo.status}`) : null}
                    {todo.blocker ? (
                      <span className="block text-amber-700 dark:text-amber-400">
                        {t("blocker", { reason: todo.blocker })}
                      </span>
                    ) : null}
                  </span>
                ) : undefined,
            }))}
        />
      ))}
      {!onSetEditorText && editorText !== undefined ? (
        <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
          {editorText}
        </p>
      ) : null}
      {(() => {
        const pendingApprovals = projection.toolApprovals.filter(
          (card) => card.status === "pending",
        );
        if (!pendingApprovals.length) return null;
        const activeIndex = Math.min(
          approvalIndex,
          pendingApprovals.length - 1,
        );
        const activeCard = pendingApprovals[activeIndex];
        return (
          <div className="space-y-1.5">
            {pendingApprovals.length > 1 ? (
              <div className="flex items-center justify-between gap-2 px-1 text-xs text-muted-foreground">
                <span className="font-medium tabular-nums">
                  {activeIndex + 1} / {pendingApprovals.length}
                </span>
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-6 rounded-md"
                    disabled={activeIndex <= 0}
                    onClick={() =>
                      setApprovalIndex((index) => Math.max(0, index - 1))
                    }
                  >
                    <ChevronLeft className="size-3.5" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-6 rounded-md"
                    disabled={activeIndex >= pendingApprovals.length - 1}
                    onClick={() =>
                      setApprovalIndex((index) =>
                        Math.min(pendingApprovals.length - 1, index + 1),
                      )
                    }
                  >
                    <ChevronRight className="size-3.5" />
                  </Button>
                </div>
              </div>
            ) : null}
            <ToolApprovalRequest
              key={`${scope}:${activeCard.id}`}
              card={activeCard}
              busy={busyId === activeCard.id}
              disabled={toolApprovalDisabled || busyId !== null}
              onDecide={onToolApproval}
              onExpire={onToolApprovalExpire}
            />
          </div>
        );
      })()}
      {projection.uiRequests.map((request) => (
        <NativeDialog
          key={`${scope}:${request.id}`}
          request={request}
          busy={busyId === request.id}
          disabled={disabled || busyId !== null}
          onOpenScreen={onOpenScreen}
          onRespond={(response) => {
            if (
              request.method === "select" &&
              response.value !== undefined &&
              !request.options.includes(response.value)
            )
              return;
            if (request.method === "takeover") onTakeoverAnswered?.();
            onRespond({
              ...response,
              ...(request.source ? { source: request.source } : {}),
            });
          }}
        />
      ))}
    </div>
  );
}
