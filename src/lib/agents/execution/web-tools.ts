import "server-only";
import { fromHtml } from "hast-util-from-html";
import { db } from "@/lib/db";
import { assertLocalRuntimeToken } from "@/lib/a2a/local-runtime";
import { A2AHttpError } from "@/lib/a2a/principal";
import {
  fetchPublicWebText,
  PublicWebFetchError,
} from "@/lib/a2a/remote-network";
import { requireAgentRevision } from "@/lib/agents/revisions";
import { resolveAgentRuntimeGrant } from "@/lib/agents/runtime-grant";
import type { AgentRuntimeTokenPayload } from "@/lib/agents/runtime-access";
import { searchKeylessWeb } from "@/lib/chat/keyless-web-search";
import { isWebSearchDeployment } from "@/lib/chat/web-search";
import { recordEvent } from "@/lib/observability/events";
import { withLogContext } from "@/lib/observability/context";
import {
  callSessionMcpTool,
  listSessionMcpTools,
} from "@/lib/process/session-mcp";
import type { McpTool } from "@/lib/process/mcp-client";
import { WebToolError } from "./web-tool-errors";

export type WebSource = { title: string; url: string; summary: string };

async function assertWebAuthority(
  token: AgentRuntimeTokenPayload,
  name: string,
) {
  const { grant } = await assertLocalRuntimeToken(token);
  const revision = await requireAgentRevision(
    db,
    grant.agentId,
    grant.agentRevisionId,
  );
  const live = await db.agent.findFirst({
    where: {
      id: grant.agentId,
      workspaceId: grant.workspaceId,
      retiredAt: null,
    },
    select: { optionalBuiltinTools: true },
  });
  if (
    !(revision.config.optionalBuiltinTools ?? []).includes(name) ||
    !live?.optionalBuiltinTools.includes(name)
  )
    throw new A2AHttpError(403, "Optional built-in tool is not enabled.");
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function sourceUrl(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.length > 4096) return undefined;
  try {
    const url = new URL(raw);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

/** Normalize the common Brave/Firecrawl JSON and Exa MCP text result formats. */
export function webSources(result: unknown, limit: number): WebSource[] {
  const sources: WebSource[] = [];
  const seen = new Set<string>();
  function add(title: unknown, urlValue: unknown, summary: unknown) {
    const url = sourceUrl(urlValue);
    if (!url || seen.has(url) || sources.length >= limit) return;
    seen.add(url);
    sources.push({
      title:
        typeof title === "string" && title.trim()
          ? title.trim().slice(0, 500)
          : url,
      url,
      summary: typeof summary === "string" ? summary.trim().slice(0, 2000) : "",
    });
  }
  function text(value: string) {
    const bounded = value.slice(0, 128 * 1024);
    try {
      visit(JSON.parse(bounded), 1);
      return;
    } catch {
      /* Provider returned prose. */
    }
    const blocks = bounded.split(/(?=^Title:\s*)/im);
    for (const block of blocks) {
      const url = /^URL:\s*(https?:\/\/\S+)/im.exec(block)?.[1];
      if (url) {
        add(
          /^Title:\s*(.+)$/im.exec(block)?.[1],
          url,
          block
            .replace(/^Title:.*$|^URL:.*$|^Published Date:.*$/gim, "")
            .replace(/^Text:\s*/im, ""),
        );
        continue;
      }
      for (const match of block.matchAll(
        /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
      ))
        add(
          match[1],
          match[2],
          block.slice(
            (match.index ?? 0) + match[0].length,
            (match.index ?? 0) + match[0].length + 2000,
          ),
        );
      for (const match of block.matchAll(/https?:\/\/[^\s<>"\])]+/g))
        add(undefined, match[0], block.slice(0, 2000));
    }
  }
  function visit(value: unknown, depth: number) {
    if (depth > 8 || sources.length >= limit) return;
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 100)) visit(item, depth + 1);
      return;
    }
    const object = record(value);
    if (!object) return;
    add(
      object.title ?? object.name,
      object.url ?? object.link ?? object.href,
      object.description ??
        object.snippet ??
        object.summary ??
        object.text ??
        object.content,
    );
    for (const key of [
      "structuredContent",
      "web",
      "results",
      "data",
      "organic",
      "organic_results",
    ])
      if (object[key]) visit(object[key], depth + 1);
    if (Array.isArray(object.content))
      for (const item of object.content.slice(0, 100)) {
        const part = record(item);
        if (typeof part?.text === "string") text(part.text);
      }
  }
  visit(result, 0);
  return sources;
}

function searchArguments(
  tool: McpTool,
  query: string,
  limit: number,
): Record<string, unknown> | undefined {
  if (
    !/(?:^|_)(?:web_)?search(?:_|$)/i.test(tool.name) ||
    /(?:image|video|local|news|code|people|company)/i.test(tool.name)
  )
    return undefined;
  const schema = record(tool.inputSchema);
  const properties = record(schema?.properties);
  if (!properties) return undefined;
  const queryKey = ["query", "q", "search_query"].find(
    (key) => properties[key],
  );
  if (!queryKey) return undefined;
  const args: Record<string, unknown> = { [queryKey]: query };
  const countKey = [
    "limit",
    "count",
    "numResults",
    "maxResults",
    "max_results",
  ].find((key) => properties[key]);
  if (countKey) args[countKey] = limit;
  if (
    Array.isArray(schema?.required) &&
    schema.required.some((key) => typeof key !== "string" || !(key in args))
  )
    return undefined;
  return args;
}

async function deployedSearch(
  token: AgentRuntimeTokenPayload,
  query: string,
  limit: number,
  signal: AbortSignal,
) {
  const grant = await resolveAgentRuntimeGrant(token);
  if (!grant)
    throw new A2AHttpError(403, "Optional built-in tool is not enabled.");
  const deployments = await db.deployment.findMany({
    where: {
      workspaceId: token.workspaceId,
      id: {
        in: token.deploymentIds.filter((id) => grant.mcpToolPolicy[id]?.length),
      },
    },
    select: {
      id: true,
      sourceRef: true,
      server: { select: { categories: { select: { slug: true } } } },
    },
    orderBy: { id: "asc" },
  });
  const context = {
    workspaceId: token.workspaceId,
    agentId: token.agentId,
    agentRevisionId: token.agentRevisionId,
    ...(token.a2aContextId
      ? { a2aContextId: token.a2aContextId }
      : { conversationId: token.conversationId }),
  };
  for (const deployment of deployments.filter(isWebSearchDeployment)) {
    signal.throwIfAborted();
    // Session MCP discovery and invocation retain immutable recipe, exposure and live binding checks.
    const tools = await listSessionMcpTools(context, deployment.id);
    for (const tool of tools) {
      const args = searchArguments(tool, query, limit);
      if (!args) continue;
      signal.throwIfAborted();
      await assertWebAuthority(token, "web_search");
      const result = await callSessionMcpTool(
        context,
        deployment.id,
        tool.name,
        args,
      );
      if (result.isError) throw new WebToolError("WEB_SEARCH_FAILED");
      return { result, deploymentId: deployment.id };
    }
  }
  return undefined;
}

/** HTML is parsed, never executed. Omit active/hidden markup and preserve block boundaries. */
export function readableWebText(html: string): { title: string; text: string } {
  const root = fromHtml(html);
  type Node = (typeof root.children)[number];
  const parts: string[] = [];
  const stack: Array<Node | string> = [...root.children].reverse();
  let title = "";
  while (stack.length) {
    const node = stack.pop();
    if (typeof node === "string") {
      parts.push(node);
      continue;
    }
    if (!node) continue;
    if (node.type === "text") {
      parts.push(node.value);
      continue;
    }
    if (node.type !== "element") continue;
    if (node.tagName === "title") {
      title = node.children
        .filter((child) => child.type === "text")
        .map((child) => child.value)
        .join("")
        .slice(0, 500);
      continue;
    }
    if (
      [
        "script",
        "style",
        "noscript",
        "template",
        "svg",
        "iframe",
        "nav",
        "footer",
      ].includes(node.tagName) ||
      node.properties.hidden ||
      node.properties.ariaHidden === "true"
    )
      continue;
    const block =
      /^(?:h[1-6]|p|div|section|article|main|header|li|ul|ol|table|tr|pre|blockquote|br|hr)$/.test(
        node.tagName,
      );
    if (block) {
      parts.push("\n");
      stack.push("\n");
    }
    for (let index = node.children.length - 1; index >= 0; index--)
      stack.push(node.children[index]);
  }
  return {
    title,
    text: parts
      .join("")
      .replace(/[\t ]+/g, " ")
      .replace(/ *\n */g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  };
}

async function untilAborted<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  const { promise, reject } = Promise.withResolvers<never>();
  const abort = () => reject(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    return await Promise.race([operation, promise]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

export async function executeWebTool(
  token: AgentRuntimeTokenPayload,
  name: "web_search" | "web_fetch",
  raw: unknown,
  signal: AbortSignal,
) {
  const started = performance.now();
  const timeout = AbortSignal.timeout(25_000);
  const boundedSignal = AbortSignal.any([signal, timeout]);
  let bytes = 0;
  let outputChars = 0;
  let resultCount = 0;
  let deploymentId: string | undefined;
  let reason: string | undefined;
  try {
    await assertWebAuthority(token, name);
    if (name === "web_search") {
      const input = raw as { query: string; limit?: number };
      const limit = input.limit ?? 5;
      const found = await untilAborted(
        withLogContext({ suppressPayload: true }, () =>
          deployedSearch(token, input.query, limit, boundedSignal),
        ),
        boundedSignal,
      );
      deploymentId = found?.deploymentId;
      if (!found) await assertWebAuthority(token, name);
      const result =
        found?.result ??
        (await searchKeylessWeb(input.query, boundedSignal, limit));
      const results = webSources(result, limit);
      if (!results.length)
        throw new WebToolError("WEB_SEARCH_UNREADABLE_RESULT");
      bytes = Buffer.byteLength(JSON.stringify(result));
      resultCount = results.length;
      outputChars = JSON.stringify(results).length;
      return { source: found ? "workspace_mcp" : "keyless_exa", results };
    }
    const input = raw as { url: string; maxChars?: number };
    const page = await fetchPublicWebText(input.url, boundedSignal, () =>
      assertWebAuthority(token, name),
    );
    bytes = page.bytes;
    const readable = /html/.test(page.contentType)
      ? readableWebText(page.text)
      : { title: "", text: page.text };
    const maxChars = input.maxChars ?? 20_000;
    const text = readable.text.slice(0, maxChars);
    outputChars = text.length;
    return {
      url: page.url,
      title: readable.title,
      contentType: page.contentType,
      text,
      truncated: readable.text.length > maxChars,
    };
  } catch (error) {
    const failure = signal.aborted
      ? new WebToolError("WEB_TOOL_CANCELLED")
      : timeout.aborted
        ? new WebToolError("WEB_TOOL_TIMEOUT")
        : error instanceof PublicWebFetchError
          ? new WebToolError(error.reason)
          : error instanceof WebToolError || error instanceof A2AHttpError
            ? error
            : new WebToolError(
                name === "web_search"
                  ? "WEB_SEARCH_FAILED"
                  : "WEB_FETCH_FAILED",
              );
    reason =
      failure instanceof WebToolError
        ? failure.reason
        : "OPTIONAL_BUILTIN_TOOL_FORBIDDEN";
    throw failure;
  } finally {
    await recordEvent({
      domain: "agent",
      eventName: "agent.web_tool",
      toolName: name,
      workspaceId: token.workspaceId,
      agentId: token.agentId,
      taskId: token.a2aTaskId,
      conversationId: token.conversationId,
      deploymentId,
      outcome: reason
        ? reason === "WEB_TOOL_TIMEOUT"
          ? "timeout"
          : reason === "WEB_TOOL_CANCELLED"
            ? "cancelled"
            : "error"
        : "success",
      errorCode: reason,
      durationMs: performance.now() - started,
      payloadPolicy: "forbidden",
      suppressPayload: true,
      attributes: {
        toolCallCount: 1,
        responseBytes: bytes,
        outputChars,
        resultCount,
      },
    });
  }
}
