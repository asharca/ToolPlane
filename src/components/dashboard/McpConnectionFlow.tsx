"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/motion/button";
import { discoverMcpConnectionAction } from "@/lib/workspace/actions";
import { ResourceEnableForm } from "./market/ResourceEnableForm";
import type { McpToolDefinition } from "@/lib/process/mcp-tool-catalog";

export type McpPendingToolChange = {
  previousSignature: string;
  currentSignature: string;
  previous: { description?: string | null };
  current: { description?: string | null };
  detectedAt: string;
};
export type McpConnectionTarget =
  | {
      kind: "agent";
      id: string;
      name: string;
      published: boolean;
      pendingToolChanges?: Record<string, McpPendingToolChange>;
    }
  | {
      kind: "assistant";
      id: string;
      name: string;
      revision: number;
      grants: Array<{ deploymentId: string; allowedToolNames: string[] }>;
      pendingToolChanges?: Record<string, McpPendingToolChange>;
    };

export function McpConnectionFlow({
  workspace,
  deploymentId,
  targets,
}: {
  workspace: string;
  deploymentId: string;
  targets: McpConnectionTarget[];
}) {
  const t = useTranslations("console.mcp");
  const router = useRouter();
  const [targetKey, setTargetKey] = useState("");
  const [tools, setTools] = useState<McpToolDefinition[] | null>(null);
  const [definitionChecksum, setDefinitionChecksum] = useState<string | null>(
    null,
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState(false);
  const [busy, startTransition] = useTransition();
  const target = targets.find(
    (item) => `${item.kind}:${item.id}` === targetKey,
  );
  const [approving, setApproving] = useState(false);
  const [approveError, setApproveError] = useState<string | null>(null);
  const approveToolChanges = async () => {
    if (!target) return;
    setApproving(true);
    setApproveError(null);
    try {
      const base =
        target.kind === "agent"
          ? `/api/v1/agents/${encodeURIComponent(target.id)}`
          : `/api/v1/chat/assistants/${encodeURIComponent(target.id)}`;
      const response = await fetch(
        `${base}/mcp/${encodeURIComponent(deploymentId)}/approve-tool-changes`,
        { method: "POST", headers: { "content-type": "application/json" } },
      );
      if (!response.ok) throw new Error(t("mcpToolChangeApproveError"));
      router.refresh();
    } catch (cause) {
      setApproveError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setApproving(false);
    }
  };
  const discover = () => {
    if (target?.kind !== "assistant") return;
    setTools(null);
    setDefinitionChecksum(null);
    setSelected(new Set());
    setError(null);
    setApplied(false);
    startTransition(async () => {
      try {
        const result = await discoverMcpConnectionAction(
          workspace,
          deploymentId,
        );
        if (result.error || !result.tools || !result.definitionChecksum) {
          setError(t("connectionDiscoveryFailed"));
          return;
        }
        setTools(result.tools);
        setDefinitionChecksum(result.definitionChecksum);
      } catch {
        setError(t("connectionDiscoveryFailed"));
      }
    });
  };
  const apply = () => {
    if (target?.kind !== "assistant" || !tools || !definitionChecksum) return;
    setError(null);
    startTransition(async () => {
      try {
        const allowedToolNames = [...selected].sort();
        const response = await fetch(
          `/api/v1/chat/assistants/${encodeURIComponent(target.id)}`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              expectedRevision: target.revision,
              mcpGrants: [
                ...target.grants.filter(
                  (grant) => grant.deploymentId !== deploymentId,
                ),
                {
                  deploymentId,
                  allowedToolNames,
                  expectedDefinitionChecksum: definitionChecksum,
                },
              ],
            }),
          },
        );
        if (!response.ok) {
          setError(t("connectionApplyFailed"));
          return;
        }
        setApplied(true);
        router.refresh();
      } catch {
        setError(t("connectionApplyFailed"));
      }
    });
  };
  return (
    <section
      className="space-y-4 rounded-xl border border-border bg-card p-5"
      aria-label={t("connectionTarget")}
    >
      <p className="text-sm text-muted-foreground">
        {t("connectionConfigurationStep")}
      </p>
      <label className="block space-y-2 text-sm font-medium">
        <span>{t("connectionTarget")}</span>
        <select
          value={targetKey}
          disabled={busy}
          onChange={(event) => {
            setTargetKey(event.target.value);
            setTools(null);
            setSelected(new Set());
            setError(null);
            setApplied(false);
          }}
          className="w-full rounded-lg border border-border bg-background p-3"
        >
          <option value="">{t("selectConnectionTarget")}</option>
          {targets.map((item) => (
            <option
              key={`${item.kind}:${item.id}`}
              value={`${item.kind}:${item.id}`}
            >
              {item.kind === "agent" ? "Agent" : "Assistant"} · {item.name}
            </option>
          ))}
        </select>
      </label>
      {!targets.length ? (
        <p role="status" className="text-sm">
          {t("connectionNoTargets")}
        </p>
      ) : null}
      {target && Object.keys(target.pendingToolChanges ?? {}).length ? (
        <div
          role="alert"
          className="space-y-2 rounded-lg border border-warning/40 bg-warning/5 p-3 text-sm"
        >
          <p className="font-medium text-warning">
            {t("mcpToolChangedPaused", {
              count: Object.keys(target.pendingToolChanges ?? {}).length,
            })}
          </p>
          <ul className="space-y-1 text-xs text-muted-foreground">
            {Object.entries(target.pendingToolChanges ?? {}).map(
              ([name, change]) => (
                <li key={name} className="break-words">
                  <span className="font-mono">{name}</span>
                  {change.previous.description !==
                  change.current.description ? (
                    <span className="block">
                      <s>{change.previous.description ?? ""}</s> →{" "}
                      {change.current.description ?? ""}
                    </span>
                  ) : null}
                </li>
              ),
            )}
          </ul>
          {approveError ? (
            <p className="text-destructive">{approveError}</p>
          ) : null}
          <Button
            type="button"
            disabled={approving}
            onClick={approveToolChanges}
          >
            {approving
              ? t("mcpToolChangeApproving")
              : t("mcpToolChangeApprove")}
          </Button>
        </div>
      ) : null}
      {target?.kind === "agent" ? (
        <ResourceEnableForm
          workspace={workspace}
          resourceId={deploymentId}
          kind="mcp"
          agents={[
            { id: target.id, name: target.name, published: target.published },
          ]}
          fixedAgentId={target.id}
        />
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            {t("connectionDiscoveryAuthorizationNotice")}
          </p>
          <Button
            type="button"
            variant="secondary"
            onClick={discover}
            disabled={!target || busy || applied}
          >
            {busy ? t("discoveringConnection") : t("discoverConnection")}
          </Button>
          {tools ? (
            <fieldset className="space-y-3" disabled={busy || applied}>
              <legend className="mb-3 text-sm font-semibold">
                {t("authorizeConnectionTools")}
              </legend>
              {tools.map((tool) => (
                <label
                  key={tool.name}
                  className="flex items-start gap-3 break-words text-sm"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(tool.name)}
                    onChange={(event) =>
                      setSelected((current) => {
                        const next = new Set(current);
                        if (event.target.checked) next.add(tool.name);
                        else next.delete(tool.name);
                        return next;
                      })
                    }
                    className="mt-1 size-4 shrink-0"
                  />
                  <span>{tool.name}</span>
                </label>
              ))}
              <Button type="button" onClick={apply} disabled={busy || applied}>
                {busy ? t("applyingConnection") : t("applyConnection")}
              </Button>
            </fieldset>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          {applied ? (
            <p role="status" className="text-sm">
              {t("connectionApplied")}
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
