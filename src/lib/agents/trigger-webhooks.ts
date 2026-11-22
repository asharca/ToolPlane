import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

export const webhookAuthKinds = ["bearer", "github"] as const;
export type WebhookAuth = (typeof webhookAuthKinds)[number];

const TEXT_LIMIT = 8_000;
const KEY_LIMIT = 200;

/** Constant-time check of GitHub's `X-Hub-Signature-256` over the exact body bytes. */
export function verifyGithubSignature(
  secret: string,
  body: string,
  header: string | null,
) {
  const match = /^sha256=([0-9a-f]{64})$/i.exec(header ?? "");
  if (!match) return false;
  const expected = createHmac("sha256", secret).update(body, "utf8").digest();
  return timingSafeEqual(expected, Buffer.from(match[1], "hex"));
}

/** Optional caller-chosen key; bounded and free of control characters. */
export function headerKey(value: string | null) {
  const key = value?.trim();
  if (!key || key.length > KEY_LIMIT) return null;
  for (const char of key) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return null;
  }
  return key;
}

type Json = Record<string, unknown>;
const record = (value: unknown): Json | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : null;
const text = (value: unknown) =>
  typeof value === "string"
    ? value.length > TEXT_LIMIT
      ? `${value.slice(0, TEXT_LIMIT)}…`
      : value
    : undefined;
const login = (value: unknown) => text(record(value)?.login);

/** `owner/repo#N` for issue, pull request and discussion events; otherwise none. */
export function githubThreadKey(payload: unknown) {
  const body = record(payload);
  const repo = text(record(body?.repository)?.full_name);
  const subject =
    record(body?.issue) ??
    record(body?.pull_request) ??
    record(body?.discussion);
  const number = subject?.number;
  return repo && Number.isSafeInteger(number) ? `${repo}#${number}` : null;
}

export function githubSender(payload: unknown) {
  const sender = record(record(payload)?.sender);
  return {
    login: text(sender?.login) ?? null,
    bot: sender?.type === "Bot",
  };
}

function subject(value: unknown) {
  const item = record(value);
  if (!item) return undefined;
  const labels = Array.isArray(item.labels)
    ? item.labels.flatMap((label) => text(record(label)?.name) ?? [])
    : undefined;
  return {
    number: item.number,
    title: text(item.title),
    state: text(item.state),
    url: text(item.html_url),
    author: login(item.user),
    labels,
    body: text(item.body),
    ...(item.merged !== undefined ? { merged: item.merged } : {}),
    ...(record(item.head)
      ? {
          head: text(record(item.head)?.ref),
          base: text(record(item.base)?.ref),
        }
      : {}),
  };
}

function comment(value: unknown) {
  const item = record(value);
  if (!item) return undefined;
  return {
    author: login(item.user),
    url: text(item.html_url),
    body: text(item.body),
    ...(item.path !== undefined
      ? { path: text(item.path), line: item.line }
      : {}),
    ...(item.state !== undefined ? { state: text(item.state) } : {}),
  };
}

/**
 * The prompt-sized view of a GitHub delivery. Full payloads routinely exceed the
 * turn input limit, so `{{payload}}` carries the fields an agent acts on.
 */
export function githubPromptPayload(event: string, payload: unknown) {
  const body = record(payload) ?? {};
  return {
    event,
    action: text(body.action),
    repository: text(record(body.repository)?.full_name),
    sender: login(body.sender),
    issue: subject(body.issue),
    pull_request: subject(body.pull_request),
    discussion: subject(body.discussion),
    comment: comment(body.comment),
    review: comment(body.review),
    ref: text(body.ref),
    release: record(body.release)
      ? {
          tag: text(record(body.release)?.tag_name),
          url: text(record(body.release)?.html_url),
        }
      : undefined,
    workflow_run: record(body.workflow_run)
      ? {
          name: text(record(body.workflow_run)?.name),
          conclusion: text(record(body.workflow_run)?.conclusion),
          head_sha: text(record(body.workflow_run)?.head_sha),
          url: text(record(body.workflow_run)?.html_url),
        }
      : undefined,
  };
}

const COMMENT_LIMIT = 60_000;
const THREAD_KEY = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9][0-9]*)$/;

export type GithubReplyResult =
  | { status: "sent" }
  | { status: "retry" }
  | { status: "failed"; code: string };

/** Posts one issue/PR comment with the trigger's own token; never throws raw errors. */
export async function postGithubComment(
  token: string,
  threadKey: string,
  body: string,
): Promise<GithubReplyResult> {
  const match = THREAD_KEY.exec(threadKey);
  if (!match) return { status: "failed", code: "GITHUB_REPLY_TARGET_INVALID" };
  const text =
    body.length > COMMENT_LIMIT ? `${body.slice(0, COMMENT_LIMIT)}…` : body;
  let response: Response;
  try {
    response = await fetch(
      `https://api.github.com/repos/${match[1]}/issues/${match[2]}/comments`,
      {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "user-agent": "ToolPlane",
          "x-github-api-version": "2022-11-28",
        },
        body: JSON.stringify({ body: text }),
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      },
    );
  } catch {
    return { status: "retry" };
  }
  await response.body?.cancel().catch(() => {});
  if (response.ok) return { status: "sent" };
  if (response.status === 401 || response.status === 403)
    return { status: "failed", code: "GITHUB_REPLY_UNAUTHORIZED" };
  if (response.status === 404 || response.status === 410)
    return { status: "failed", code: "GITHUB_REPLY_NOT_FOUND" };
  if (response.status === 429 || response.status >= 500)
    return { status: "retry" };
  return { status: "failed", code: "GITHUB_REPLY_FAILED" };
}
