"use client";

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import { Database, ScrollText, Server } from "lucide-react";
import { apiRequest } from "@/lib/client/api";
import { DisplayError } from "./display-error";
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

/** Same-origin JSON call whose failure surfaces in the menu as safe text. */
async function menuRequest<T>(
  url: string,
  fallback: string,
  init?: Parameters<typeof apiRequest>[1],
): Promise<T> {
  const result = await apiRequest<T>(url, init);
  if (!result.ok) throw new DisplayError(result.message ?? fallback);
  return result.data;
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
          const body = await menuRequest<{ items?: McpServer[] }>(
            withQuery(composerPath, { section: "mcp" }),
            t("loadMcpServersFailed"),
            { cache: "no-store", signal },
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
            const body = await menuRequest<{ items?: McpResource[] }>(
              withQuery(composerPath, { section: "resources" }),
              t("loadMcpResourcesFailed"),
              { cache: "no-store", signal },
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
          const body = await menuRequest<{ prompts?: McpPrompt[] }>(
            promptsPath,
            t("loadMcpPromptsFailed"),
            { cache: "no-store", signal },
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
      const body = await menuRequest<{ text?: string }>(
        promptsPath,
        t("resolveMcpPromptFailed"),
        {
          method: "POST",
          json: {
            deploymentId: prompt.deploymentId,
            name: prompt.name,
            arguments: values,
          },
        },
      );
      if (typeof body?.text !== "string")
        throw new DisplayError(t("resolveMcpPromptFailed"));
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
        const body = await menuRequest<{ text?: string }>(
          composerPath,
          t("resolveMcpResourceFailed"),
          {
            method: "POST",
            json: {
              kind: "resource",
              id: resource.id,
              deploymentId: resource.deploymentId,
              ...(conversationId ? { conversationId } : {}),
              ...(workSessionId ? { workSessionId } : {}),
            },
          },
        );
        if (typeof body?.text !== "string")
          throw new DisplayError(t("resolveMcpResourceFailed"));
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
