"use client";

import { useEffect, useId, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Button, ButtonLink } from "@/components/motion/button";
import { FormSelect } from "@/components/ui/FormSelect";
import {
  enableAgentResourceAction,
  previewAgentResourceAction,
  type ResourceEnableState,
} from "@/lib/agents/actions";

type ResourceEnableProps = {
  workspace: string;
  resourceId: string;
  agents: Array<{ id: string; name: string; published: boolean }>;
  fixedAgentId?: string;
};

export function ResourceEnableForm(props: ResourceEnableProps) {
  return (
    <ResourceReviewForm
      key={`${props.workspace}:${props.resourceId}:${props.fixedAgentId ?? ""}`}
      {...props}
    />
  );
}

function ResourceReviewForm({
  workspace,
  resourceId,
  agents,
  fixedAgentId,
}: ResourceEnableProps) {
  const t = useTranslations("console.resourceEnable");
  const selectId = useId();
  const [agentId, setAgentId] = useState(fixedAgentId ?? "");
  const [review, setReview] = useState<ResourceEnableState | null>(null);
  const [result, setResult] = useState<ResourceEnableState>({});
  const [confirmed, setConfirmed] = useState(false);
  const [stale, setStale] = useState(false);
  const [pending, startTransition] = useTransition();
  const agent = agents.find((item) => item.id === agentId);
  const scopeMatches =
    review !== null &&
    review.agentId === agentId &&
    review.resourceId === resourceId &&
    review.resourceKind === "skill";
  const prepared = Boolean(
    scopeMatches &&
      review?.expectedRevisionId &&
      review.reviewReceipt &&
      review.sourceChecksum &&
      review.expiresAt &&
      review.skill,
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
    form.set("resourceKind", "skill");
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
          next.resourceKind !== "skill" ||
          !next.skill
        ) {
          setResult({ error: "previewFailed" });
          return;
        }
        setReview(next);
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
    revisionPreparationRequired: "resourceRevisionPreparationRequired",
    reviewRequired: "resourcePreviewExpired",
    reviewExpired: "resourcePreviewExpired",
    resourceChanged: "resourcePreviewExpired",
    AGENT_REVISION_CONFLICT: "resourcePreviewExpired",
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
          <div className="block space-y-1 text-sm">
            <label htmlFor={selectId}>{t("resourceAgent")}</label>
            <FormSelect
              id={selectId}
              label={t("resourceAgent")}
              value={agentId}
              required
              disabled={pending}
              onValueChange={(value) => {
                setAgentId(value);
                setReview(null);
                setResult({});
                setConfirmed(false);
                setStale(false);
              }}
              options={[
                { value: "", label: t("resourceAgent") },
                ...agents.map((item) => ({ value: item.id, label: item.name })),
              ]}
            />
          </div>
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
        {review?.skill && scopeMatches ? (
          <div className="min-w-0 space-y-3 rounded-xl border border-border p-3">
            <h3 className="font-medium">{t("resourceReviewTitle")}</h3>
            <p className="break-all font-mono text-xs">
              {review.sourceChecksum}
            </p>
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
            {t(errors[result.error] ?? "resourceBindingFailed")}
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
