"use client";

import { useEffect, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Button, ButtonLink } from "@/components/motion/button";
import {
  enableAgentResourceAction,
  previewAgentResourceAction,
  type ResourceEnableState,
} from "@/lib/agents/actions";

type ResourceEnableProps = {
  workspace: string;
  resourceId: string;
  kind: "skill" | "mcp";
  agents: Array<{ id: string; name: string; published: boolean }>;
  fixedAgentId?: string;
};

export function ResourceEnableForm(props: ResourceEnableProps) {
  return (
    <ResourceReviewForm
      key={`${props.workspace}:${props.kind}:${props.resourceId}:${props.fixedAgentId ?? ""}`}
      {...props}
    />
  );
}

function ResourceReviewForm({
  workspace,
  resourceId,
  kind,
  agents,
  fixedAgentId,
}: ResourceEnableProps) {
  const t = useTranslations("console.market");
  const mcp = useTranslations("console.mcp");
  const [agentId, setAgentId] = useState(fixedAgentId ?? "");
  const [review, setReview] = useState<ResourceEnableState | null>(null);
  const [result, setResult] = useState<ResourceEnableState>({});
  const [selectedTools, setSelectedTools] = useState<string[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [stale, setStale] = useState(false);
  const [pending, startTransition] = useTransition();
  const agent = agents.find((item) => item.id === agentId);
  const scopeMatches =
    review !== null &&
    review.agentId === agentId &&
    review.resourceId === resourceId &&
    review.resourceKind === kind;
  const prepared = Boolean(
    scopeMatches &&
      review?.expectedRevisionId &&
      review.reviewReceipt &&
      review.sourceChecksum &&
      review.expiresAt &&
      (kind === "skill" ? review.skill : review.tools),
  );
  useEffect(() => {
    if (!review?.expiresAt) return;
    const remaining = new Date(review.expiresAt).getTime() - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) {
      setStale(true);
      return;
    }
    const timer = setTimeout(() => setStale(true), remaining);
    return () => clearTimeout(timer);
  }, [review]);

  const scopeForm = () => {
    const form = new FormData();
    form.set("workspace", workspace);
    form.set("resourceKind", kind);
    form.set("resourceId", resourceId);
    form.set("agentId", agentId);
    return form;
  };
  const preview = () => {
    setResult({});
    if (review) setStale(true);
    startTransition(async () => {
      try {
        const next = await previewAgentResourceAction({}, scopeForm());
        if (next.error) {
          setResult(next);
          return;
        }
        if (
          !next.reviewReceipt ||
          !next.expectedRevisionId ||
          !next.sourceChecksum ||
          !next.expiresAt ||
          next.agentId !== agentId ||
          next.resourceId !== resourceId ||
          next.resourceKind !== kind ||
          !(kind === "skill" ? next.skill : next.tools)
        ) {
          setResult({ error: "previewFailed" });
          return;
        }
        setReview(next);
        setSelectedTools([]);
        setConfirmed(false);
        setStale(new Date(next.expiresAt).getTime() <= Date.now());
      } catch {
        setResult({ error: "previewFailed" });
      }
    });
  };
  const apply = () => {
    if (!prepared || !review || !confirmed || stale || !agent?.published)
      return;
    if (
      !review.expiresAt ||
      new Date(review.expiresAt).getTime() <= Date.now()
    ) {
      setStale(true);
      return;
    }
    const form = scopeForm();
    form.set("expectedRevisionId", review.expectedRevisionId ?? "");
    form.set("reviewReceipt", review.reviewReceipt ?? "");
    form.set("confirm", "yes");
    if (kind === "mcp")
      form.set("allowedToolNames", JSON.stringify([...selectedTools].sort()));
    setResult({});
    startTransition(async () => {
      try {
        const next = await enableAgentResourceAction({}, form);
        if (
          !next.error &&
          (!next.enabled || !next.revisionId || next.agentId !== agentId)
        ) {
          setResult({ error: "resource_binding_unavailable" });
          return;
        }
        setResult(next);
        if (
          [
            "reviewRequired",
            "reviewExpired",
            "resourceChanged",
            "revisionPreparationRequired",
            "AGENT_REVISION_CONFLICT",
            "MCP_DEFINITION_CHANGED",
            "MCP_RUNTIME_FILES_CHANGED",
            "MCP_CONNECTION_RESTART_REQUIRED",
            "MCP_DISCOVERY_REQUIRED",
            "MCP_TOOL_SELECTION_CHANGED",
          ].includes(next.error ?? "")
        )
          setStale(true);
        if (next.enabled && next.revisionId && next.agentId === agentId)
          setStale(true);
      } catch {
        setResult({ error: "resource_binding_unavailable" });
      }
    });
  };
  const errors: Record<string, string> = {
    resource_binding_busy: "resourceBindingBusy",
    resource_binding_consent: "resourceBindingConsent",
    resource_binding_unavailable: "resourceBindingFailed",
    credentialsRequired: "setupMcpCredentialsRequired",
    deploymentNotRunning: "setupMcpNotRunning",
    connectorFailed: "setupMcpTestFailed",
    revisionPreparationRequired: "resourceRevisionPreparationRequired",
    reviewRequired: "resourcePreviewExpired",
    reviewExpired: "resourcePreviewExpired",
    resourceChanged: "resourcePreviewExpired",
    AGENT_REVISION_CONFLICT: "resourcePreviewExpired",
    MCP_DEFINITION_CHANGED: "resourcePreviewExpired",
    MCP_RUNTIME_FILES_CHANGED: "resourcePreviewExpired",
    MCP_CONNECTION_RESTART_REQUIRED: "resourcePreviewExpired",
    MCP_DISCOVERY_REQUIRED: "resourcePreviewExpired",
    MCP_TOOL_SELECTION_CHANGED: "resourcePreviewExpired",
    previewFailed: "resourcePreviewFailed",
  };
  const published =
    result.enabled === true &&
    Boolean(result.revisionId) &&
    result.agentId === agentId;
  return (
    <section className="space-y-3 rounded-lg border border-border p-4">
      <h2 className="font-semibold">{t("resourceUseTitle")}</h2>
      <p className="text-sm text-muted-foreground">
        {t("resourceUseDescription")}
      </p>
      {!agents.length ? <p>{t("resourceNoEligibleAgents")}</p> : null}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          apply();
        }}
        className="space-y-3"
      >
        {!fixedAgentId ? (
          <label className="block space-y-1 text-sm">
            <span>{t("resourceAgent")}</span>
            <select
              value={agentId}
              required
              disabled={pending}
              onChange={(event) => {
                setAgentId(event.target.value);
                setReview(null);
                setResult({});
                setSelectedTools([]);
                setConfirmed(false);
                setStale(false);
              }}
              className="w-full rounded-md border border-border bg-background px-3 py-2"
            >
              <option value="">{t("resourceAgent")}</option>
              {agents.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {agent && !agent.published ? (
          <p role="status" className="text-sm">
            {t("resourceRevisionPreparationRequired")}
          </p>
        ) : null}
        <Button
          type="button"
          onClick={preview}
          disabled={pending || !agent?.published}
          variant="secondary"
          size="sm"
        >
          {pending ? t("resourcePreviewing") : t("resourcePreview")}
        </Button>
        {review && scopeMatches ? (
          <div className="min-w-0 space-y-3 rounded-md border border-border p-3">
            <h3 className="font-medium">{t("resourceReviewTitle")}</h3>
            <p className="break-all font-mono text-xs">
              {review.sourceChecksum}
            </p>
            {review.skill ? (
              <>
                <h4 className="font-medium">{review.skill.name}</h4>
                <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs">
                  {review.skill.markdown}
                </pre>
                <pre className="overflow-auto text-xs">
                  {JSON.stringify(
                    {
                      userInvocable: review.skill.userInvocable,
                      agentInvocable: review.skill.agentInvocable,
                      effort: review.skill.effort,
                    },
                    null,
                    2,
                  )}
                </pre>
                {review.skill.files.map((file) => (
                  <details key={file.path} className="min-w-0">
                    <summary className="break-all">
                      {file.path}
                      {file.encoding ? ` (${file.encoding})` : ""}
                    </summary>
                    <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs">
                      {file.content}
                    </pre>
                  </details>
                ))}
              </>
            ) : null}
            {kind === "mcp" ? (
              <fieldset
                className="space-y-2"
                disabled={pending || stale || published}
              >
                <legend className="text-sm font-medium">
                  {t("resourceReviewTools")}
                </legend>
                {review.tools?.map((tool) => (
                  <label
                    key={tool.name}
                    className="flex items-start gap-2 break-all text-sm"
                  >
                    <input
                      type="checkbox"
                      checked={selectedTools.includes(tool.name)}
                      onChange={(event) =>
                        setSelectedTools((current) =>
                          event.target.checked
                            ? [...current, tool.name]
                            : current.filter((name) => name !== tool.name),
                        )
                      }
                      className="mt-1 size-4 shrink-0"
                    />
                    <span>
                      <span className="font-mono">{tool.name}</span>
                      {tool.description ? (
                        <span className="block text-xs text-muted-foreground">
                          {tool.description}
                        </span>
                      ) : null}
                    </span>
                  </label>
                ))}
              </fieldset>
            ) : null}
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                required
                checked={confirmed}
                disabled={pending || stale || published}
                onChange={(event) => setConfirmed(event.target.checked)}
                className="mt-1 size-4 shrink-0"
              />
              <span>{t("resourceReviewConsent")}</span>
            </label>
            {stale && !published ? (
              <p role="status" className="text-sm">
                {t("resourcePreviewExpired")}
              </p>
            ) : null}
          </div>
        ) : null}
        {result.error ? (
          <p role="alert" className="text-sm text-destructive">
            {result.error === "MCP_TOOLS_NOT_EXPOSED"
              ? mcp("connectionToolsNotExposed")
              : t(errors[result.error] ?? "resourceBindingFailed")}
          </p>
        ) : null}
        {published ? (
          <p role="status" className="break-all text-sm">
            {t("resourcePublishedRevision")}: <code>{result.revisionId}</code>
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button
            type="submit"
            disabled={
              pending ||
              !agent?.published ||
              !prepared ||
              !confirmed ||
              stale ||
              published
            }
            variant="primary"
            size="sm"
          >
            {pending ? t("updating") : t("resourceApplyRevision")}
          </Button>
          {agentId ? (
            <ButtonLink
              href={`/app/${encodeURIComponent(workspace)}/agents/${encodeURIComponent(agentId)}`}
              variant="ghost"
              size="sm"
            >
              {t(
                agent?.published
                  ? "setupAgentSettingsLink"
                  : "resourcePrepareRevision",
              )}
            </ButtonLink>
          ) : null}
        </div>
      </form>
    </section>
  );
}
