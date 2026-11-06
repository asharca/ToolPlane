"use client";

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import { Database, ScrollText, Server } from "lucide-react";
import type {
  ComposerMenuItem,
  ComposerMenuOutcome,
  ComposerMenuView,
} from "./composer-menu";

type McpPrompt = {
  deploymentId: string;
  serverName: string;
  name: string;
  title?: string;
  description?: string;
  arguments: Array<{
    name: string;
    title?: string;
    description?: string;
    required?: boolean;
  }>;
};
type McpResource = {
  kind: "resource";
  id: string;
  deploymentId: string;
  label: string;
  description?: string;
};
type McpServer = {
  id: string;
  label: string;
  status: "running" | "available" | "unavailable";
};

const MCP_VIEWS = ["mcp-servers", "mcp-resources", "mcp-prompts"] as const;

function withQuery(path: string, params: Record<string, string>) {
  return `${path}${path.includes("?") ? "&" : "?"}${new URLSearchParams(params)}`;
}

async function readJson<T>(response: Response, fallback: string): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as T & {
    error?: string;
  };
  if (!response.ok) throw new Error(body.error || fallback);
  return body;
}

/**
 * MCP servers, resources and prompts as drill-down views of the composer menu.
 * `resources: false` lets a surface supply its own resource view (Work references).
 */
export function useMcpComposerMenu({
  composerPath,
  promptsPath,
  resources = true,
  resourceContext,
}: {
  /** GET `?section=mcp|resources`, POST resolves a resource to text. */
  composerPath?: string;
  /** GET lists prompts, POST resolves one to text. */
  promptsPath?: string;
  resources?: boolean;
  resourceContext?: { conversationId?: string; workSessionId?: string };
}) {
  const t = useTranslations("console.agents");
  const conversationId = resourceContext?.conversationId;
  const workSessionId = resourceContext?.workSessionId;

  return useMemo(() => {
    const group = t("mcp");
    const rootItems: ComposerMenuItem[] = [
      ...(composerPath && resources
        ? [
            {
              id: "mcp-resources",
              label: t("mcpResources"),
              icon: Database,
              group,
              drill: true,
            },
          ]
        : []),
      ...(promptsPath
        ? [
            {
              id: "mcp-prompts",
              label: t("mcpPrompts"),
              icon: ScrollText,
              group,
              drill: true,
            },
          ]
        : []),
      ...(composerPath
        ? [
            {
              id: "mcp-servers",
              label: t("mcpServers"),
              icon: Server,
              group,
              drill: true,
            },
          ]
        : []),
    ];
    const views: Record<string, ComposerMenuView> = {};
    if (composerPath) {
      views["mcp-servers"] = {
        title: t("mcpServers"),
        empty: t("noMcpServers"),
        load: async (_query, signal) => {
          const body = await readJson<{ items?: McpServer[] }>(
            await fetch(withQuery(composerPath, { section: "mcp" }), {
              cache: "no-store",
              signal,
            }),
            t("loadMcpServersFailed"),
          );
          return (body.items ?? []).map((server) => ({
            id: `server:${server.id}`,
            label: server.label,
            icon: Server,
            // Status only: servers are not insertable.
            readOnly: true,
            hint:
              server.status === "running"
                ? t("mcpRunning")
                : server.status === "available"
                  ? t("mcpAvailable")
                  : t("mcpUnavailable"),
          }));
        },
      };
      if (resources)
        views["mcp-resources"] = {
          title: t("mcpResources"),
          empty: t("noMcpResources"),
          load: async (_query, signal) => {
            const body = await readJson<{ items?: McpResource[] }>(
              await fetch(withQuery(composerPath, { section: "resources" }), {
                cache: "no-store",
                signal,
              }),
              t("loadMcpResourcesFailed"),
            );
            return (body.items ?? [])
              .filter((item) => item?.kind === "resource")
              .map((resource) => ({
                id: `resource:${resource.deploymentId}:${resource.id}`,
                label: resource.label,
                description: resource.description ?? resource.id,
                icon: Database,
                data: resource,
              }));
          },
        };
    }
    if (promptsPath)
      views["mcp-prompts"] = {
        title: t("mcpPrompts"),
        empty: t("noMcpPrompts"),
        load: async (_query, signal) => {
          const body = await readJson<{ prompts?: McpPrompt[] }>(
            await fetch(promptsPath, { cache: "no-store", signal }),
            t("loadMcpPromptsFailed"),
          );
          return (body.prompts ?? []).map((prompt) => ({
            id: `prompt:${prompt.deploymentId}:${prompt.name}`,
            label: prompt.title ?? prompt.name,
            description: prompt.description ?? prompt.serverName,
            icon: ScrollText,
            drill: prompt.arguments.length > 0,
            data: prompt,
          }));
        },
      };

    async function resolvePrompt(
      prompt: McpPrompt,
      values: Record<string, string>,
      insertText: (text: string) => void,
    ) {
      if (!promptsPath) return;
      const body = await readJson<{ text?: string }>(
        await fetch(promptsPath, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            deploymentId: prompt.deploymentId,
            name: prompt.name,
            arguments: values,
          }),
        }),
        t("resolveMcpPromptFailed"),
      );
      if (typeof body.text !== "string")
        throw new Error(t("resolveMcpPromptFailed"));
      insertText(body.text);
    }

    /** Returns null when the item is not an MCP item. */
    async function activate(
      item: ComposerMenuItem,
      view: string,
      insertText: (text: string) => void,
    ): Promise<ComposerMenuOutcome | null> {
      if (view === "root" && (MCP_VIEWS as readonly string[]).includes(item.id))
        return { view: item.id };
      if (view === "mcp-resources" && composerPath) {
        const resource = item.data as McpResource;
        const body = await readJson<{ text?: string }>(
          await fetch(composerPath, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              kind: "resource",
              id: resource.id,
              deploymentId: resource.deploymentId,
              ...(conversationId ? { conversationId } : {}),
              ...(workSessionId ? { workSessionId } : {}),
            }),
          }),
          t("resolveMcpResourceFailed"),
        );
        if (typeof body.text !== "string")
          throw new Error(t("resolveMcpResourceFailed"));
        insertText(body.text);
        return undefined;
      }
      if (view === "mcp-prompts") {
        const prompt = item.data as McpPrompt;
        if (!prompt.arguments.length) {
          await resolvePrompt(prompt, {}, insertText);
          return undefined;
        }
        return {
          form: {
            title: prompt.title ?? prompt.name,
            subtitle: prompt.serverName,
            description: prompt.description,
            fields: prompt.arguments.map((argument) => ({
              name: argument.name,
              label: argument.title ?? argument.name,
              required: argument.required,
              placeholder: argument.description ?? argument.name,
            })),
            submitLabel: t("insertMcpPrompt"),
            submit: (values) => resolvePrompt(prompt, values, insertText),
          },
        };
      }
      return null;
    }

    return { rootItems, views, activate };
  }, [composerPath, conversationId, promptsPath, resources, t, workSessionId]);
}
