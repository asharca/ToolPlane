import "server-only";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  RequestMalformedError,
  UnsupportedOperationError,
} from "@a2a-js/sdk/errors";
export class NativeUiProjectionLimitError extends Error {}

const id = z.string().min(1).max(200);
const text = z.string();
export const NativeUiSource = z
  .object({
    subagentId: id,
    subagentVersionId: id.optional(),
    subagentName: z.string().max(240).optional(),
    parentToolCallId: id.optional(),
    depth: z.number().int().min(0).max(32).optional(),
  })
  .strict();
const base = {
  type: z.literal("extension_ui_request"),
  id,
  source: NativeUiSource.optional(),
};
const AskQuestion = z
  .object({
    id,
    question: text,
    options: z.array(
      z.object({ label: text.min(1), description: text.optional() }).strict(),
    ),
    multi: z.boolean().optional(),
    recommended: z.number().int().nonnegative().optional(),
  })
  .strict()
  .superRefine((question, ctx) => {
    if (
      new Set(question.options.map((option) => option.label)).size !==
        question.options.length ||
      (question.recommended !== undefined &&
        question.recommended >= question.options.length)
    )
      ctx.addIssue({
        code: "custom",
        message: "Invalid native question options",
      });
  });
const AskAnswer = z
  .object({
    id,
    selectedOptions: z.array(text),
    customInput: text.optional(),
  })
  .strict();
export const NativeUiRequest = z.discriminatedUnion("method", [
  z
    .object({
      ...base,
      method: z.literal("ask"),
      title: text,
      questions: z
        .array(AskQuestion)
        .min(1)
        .max(64)
        .refine(
          (questions) =>
            new Set(questions.map((question) => question.id)).size ===
            questions.length,
          "Duplicate native question IDs",
        ),
      timeout: z.number().nonnegative().optional(),
    })
    .strict(),
  z
    .object({
      ...base,
      method: z.literal("select"),
      title: text,
      options: z.array(text),
      timeout: z.number().nonnegative().optional(),
    })
    .strict(),
  z
    .object({
      ...base,
      method: z.literal("confirm"),
      title: text,
      message: text,
      timeout: z.number().nonnegative().optional(),
    })
    .strict(),
  z
    .object({
      ...base,
      method: z.literal("input"),
      title: text,
      placeholder: text.optional(),
      timeout: z.number().nonnegative().optional(),
    })
    .strict(),
  z
    .object({
      ...base,
      method: z.literal("editor"),
      title: text,
      prefill: text.optional(),
    })
    .strict(),
  z
    .object({
      ...base,
      method: z.literal("notify"),
      message: text,
      notifyType: z.enum(["info", "warning", "error"]).optional(),
    })
    .strict(),
  z
    .object({
      ...base,
      method: z.literal("setStatus"),
      statusKey: text,
      statusText: text.optional(),
    })
    .strict(),
  z
    .object({
      ...base,
      method: z.literal("setWidget"),
      widgetKey: text,
      widgetLines: z.array(text).optional(),
      widgetPlacement: z.enum(["aboveEditor", "belowEditor"]).optional(),
    })
    .strict(),
  z.object({ ...base, method: z.literal("setTitle"), title: text }).strict(),
  z.object({ ...base, method: z.literal("set_editor_text"), text }).strict(),
]);
export const NativeUiResponse = z
  .object({
    type: z.literal("extension_ui_response"),
    id,
    source: NativeUiSource.optional(),
    value: text.optional(),
    confirmed: z.boolean().optional(),
    cancelled: z.boolean().optional(),
    answers: z.array(AskAnswer).max(64).optional(),
  })
  .strict();
const Todo = z
  .object({
    id: z.number().int(),
    text: z.string(),
    done: z.boolean(),
    status: z
      .enum(["pending", "in_progress", "completed", "abandoned", "blocked"])
      .optional(),
    phase: text.optional(),
    blocker: text.optional(),
    source: NativeUiSource.optional(),
  })
  .strict();
const NativeUiActivity = z
  .object({
    type: z.enum(["reasoning", "tool"]),
    status: z.enum(["running", "completed", "failed"]),
    source: NativeUiSource,
    toolCallId: id.optional(),
    toolName: z.string().max(240).optional(),
    delta: z.string().max(20_000).optional(),
    input: z.json().optional(),
    output: z.json().optional(),
    isError: z.boolean().optional(),
  })
  .strict();
export const NativeHookActivity = z
  .object({
    id,
    pluginInstallId: id,
    pluginName: z.string().min(1).max(240),
    event: z.string().min(1).max(200),
    status: z.enum(["completed", "failed", "timed_out"]),
    durationMs: z.number().int().nonnegative(),
    result: z
      .enum(["blocked", "cancelled", "modified", "unchanged"])
      .optional(),
    source: NativeUiSource.optional(),
  })
  .strict();
export const NativeUiAction = z.discriminatedUnion("action", [
  z.object({ action: z.literal("request"), request: NativeUiRequest }).strict(),
  z.object({ action: z.literal("poll"), id }).strict(),
  z.object({ action: z.literal("resolve"), id }).strict(),
  z
    .object({
      action: z.literal("todos"),
      todos: z.array(Todo),
      source: NativeUiSource.optional(),
    })
    .strict(),
  z
    .object({ action: z.literal("activity"), activity: NativeUiActivity })
    .strict(),
  z.object({ action: z.literal("hook"), hook: NativeHookActivity }).strict(),
]);
type Request = z.infer<typeof NativeUiRequest>;
type Response = z.infer<typeof NativeUiResponse>;
type Dialog = {
  request: Request;
  expiresAt: number;
  response?: Response;
  resolved?: boolean;
};
export type NativeUiProjection = {
  lease?: string;
  dialogs: Dialog[];
  todos: z.infer<typeof Todo>[];
  uiEvents: Request[];
  activities: z.infer<typeof NativeUiActivity>[];
  hooks: z.infer<typeof NativeHookActivity>[];
};
export function nativeUiProjection(value: unknown): NativeUiProjection {
  const v = value as Partial<NativeUiProjection> | null;
  return {
    lease: v?.lease,
    dialogs: v?.dialogs ?? [],
    todos: v?.todos ?? [],
    uiEvents: v?.uiEvents ?? [],
    activities: v?.activities ?? [],
    hooks: v?.hooks ?? [],
  };
}
export function nativeUiView(
  value: unknown,
  lease?: string | null,
  live = false,
) {
  const p = nativeUiProjection(value);
  return {
    uiRequests:
      live && lease && p.lease === lease
        ? p.dialogs
            .filter(
              (d) => !d.resolved && !d.response && d.expiresAt > Date.now(),
            )
            .map((d) => d.request)
        : [],
    todos: p.todos,
    uiEvents: p.uiEvents,
    activities: p.activities,
    hooks: p.hooks,
  };
}
export function applyNativeUiAction(
  value: unknown,
  lease: string,
  deadline: number,
  input: z.infer<typeof NativeUiAction>,
) {
  const p = nativeUiProjection(value);
  if (p.lease !== lease) {
    p.lease = lease;
    p.dialogs = [];
  }
  let response: Response | undefined;
  if (input.action === "todos") {
    const childId = input.source?.subagentId;
    p.todos = [
      ...p.todos.filter((todo) => todo.source?.subagentId !== childId),
      ...input.todos.map((todo) => ({ ...todo, source: input.source })),
    ];
  } else if (input.action === "activity") {
    const activity = input.activity;
    p.activities = p.activities.filter(
      (entry) =>
        entry.source.subagentId !== activity.source.subagentId ||
        entry.toolCallId !== activity.toolCallId ||
        entry.type !== activity.type,
    );
    p.activities.push(activity);
    p.activities = p.activities.slice(-64);
    while (
      p.activities.length > 1 &&
      Buffer.byteLength(JSON.stringify(p)) > 196_608
    )
      p.activities.shift();
  } else if (input.action === "hook") {
    const previous = p.hooks.find((hook) => hook.id === input.hook.id);
    if (previous && !isDeepStrictEqual(previous, input.hook))
      throw new RequestMalformedError("Hook invocation ID was reused.");
    if (!previous) p.hooks.push(input.hook);
    p.hooks = p.hooks.slice(-64);
    while (p.hooks.length > 1 && Buffer.byteLength(JSON.stringify(p)) > 196_608)
      p.hooks.shift();
  } else if (input.action === "request") {
    const r = input.request;
    if (["select", "confirm", "input", "editor", "ask"].includes(r.method)) {
      let d = p.dialogs.find((d) => d.request.id === r.id);
      if (d && !isDeepStrictEqual(d.request, r))
        throw new RequestMalformedError("Native dialog ID was reused.");
      if (!d) {
        if (
          p.dialogs.filter(
            (d) => !d.resolved && !d.response && d.expiresAt > Date.now(),
          ).length >= 32
        )
          throw new UnsupportedOperationError("Native dialog queue is full.");
        d = {
          request: r,
          expiresAt: Math.min(
            deadline,
            "timeout" in r && r.timeout ? Date.now() + r.timeout : deadline,
          ),
        };
        p.dialogs.push(d);
      }
      if (d.expiresAt <= Date.now() || d.resolved)
        response = {
          type: "extension_ui_response",
          id: r.id,
          ...(r.source ? { source: r.source } : {}),
          cancelled: true,
        };
      else response = d.response;
    } else {
      const key = (r: Request) =>
        `${r.source?.subagentId ?? "main"}:` +
        (r.method === "setStatus"
          ? `status:${r.statusKey}`
          : r.method === "setWidget"
            ? `widget:${r.widgetKey}`
            : r.method);
      if (r.method !== "notify")
        p.uiEvents = p.uiEvents.filter((e) => key(e) !== key(r));
      const clearing =
        (r.method === "setStatus" && r.statusText === undefined) ||
        (r.method === "setWidget" && r.widgetLines === undefined);
      if (!clearing) p.uiEvents.push(r);
      p.uiEvents = p.uiEvents.slice(-64);
    }
  } else {
    const d = p.dialogs.find((d) => d.request.id === input.id);
    if (input.action === "resolve") {
      if (d) d.resolved = true;
    } else if (!d || d.resolved || d.expiresAt <= Date.now())
      response = {
        type: "extension_ui_response",
        id: input.id,
        ...(d?.request.source ? { source: d.request.source } : {}),
        cancelled: true,
      };
    else response = d.response;
  }
  // Non-dialog events are a latest bounded display, not an append-only journal.
  while (
    Buffer.byteLength(JSON.stringify(p)) > 262_144 &&
    p.uiEvents.length > 1
  )
    p.uiEvents.shift();
  if (Buffer.byteLength(JSON.stringify(p)) > 262_144)
    throw new NativeUiProjectionLimitError(
      "Native UI display projection exceeds 256 KiB.",
    );
  return { projection: p, result: response ? { response } : {} };
}
export function respondNativeUi(
  value: unknown,
  lease: string,
  response: Response,
) {
  const p = nativeUiProjection(value);
  const d =
    p.lease === lease && p.dialogs.find((d) => d.request.id === response.id);
  if (!d || d.resolved || d.response || d.expiresAt <= Date.now())
    throw new UnsupportedOperationError(
      "Native dialog is stale or already answered.",
    );
  if (
    response.source !== undefined &&
    !isDeepStrictEqual(d.request.source, response.source)
  )
    throw new RequestMalformedError(
      "Native dialog response source does not match its request.",
    );
  if (!response.cancelled) {
    if (d.request.method === "ask") {
      const answers = response.answers;
      if (
        !answers ||
        response.value !== undefined ||
        response.confirmed !== undefined ||
        answers.length !== d.request.questions.length ||
        new Set(answers.map((answer) => answer.id)).size !== answers.length
      )
        throw new RequestMalformedError("Expected native question answers.");
      for (const question of d.request.questions) {
        const answer = answers.find((entry) => entry.id === question.id);
        if (
          !answer ||
          (!question.multi && answer.selectedOptions.length > 1) ||
          new Set(answer.selectedOptions).size !==
            answer.selectedOptions.length ||
          answer.selectedOptions.some(
            (label) =>
              !question.options.some((option) => option.label === label),
          ) ||
          (answer.selectedOptions.length === 0 && !answer.customInput?.trim())
        )
          throw new RequestMalformedError("Invalid native question answer.");
      }
    } else if (d.request.method === "confirm") {
      if (
        typeof response.confirmed !== "boolean" ||
        response.value !== undefined ||
        response.answers !== undefined
      )
        throw new RequestMalformedError(
          "Expected native confirmation response.",
        );
    } else if (
      typeof response.value !== "string" ||
      response.confirmed !== undefined ||
      response.answers !== undefined ||
      (d.request.method === "select" &&
        !d.request.options.includes(response.value))
    )
      throw new RequestMalformedError("Expected native dialog value.");
  } else if (
    response.value !== undefined ||
    response.confirmed !== undefined ||
    response.answers !== undefined
  )
    throw new RequestMalformedError(
      "Cancelled response cannot contain a value.",
    );
  d.response = {
    ...response,
    ...(d.request.source ? { source: d.request.source } : {}),
  };
  if (Buffer.byteLength(JSON.stringify(p)) > 262_144)
    throw new NativeUiProjectionLimitError(
      "Native UI display projection exceeds 256 KiB.",
    );
  return p;
}
