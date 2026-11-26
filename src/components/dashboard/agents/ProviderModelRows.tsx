"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { FlaskConical } from "lucide-react";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import { testProviderModelAction } from "@/lib/agents/provider-actions";
import type { ActionState } from "@/lib/agents/action-state";
import { ActionMessage } from "./ProviderDialogs";
import {
  compactTokens,
  DeleteModelForm,
  EditModelDialog,
  ModelTypeIcon,
} from "./ProviderModelForm";
import type { ProviderModelRow } from "./ProvidersPanel";

// Model name | context | max output | input price | output price | actions.
// Below xl the numeric columns fold into a single line under the name.
export const MODEL_ROW_GRID =
  "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 xl:grid-cols-[minmax(0,1fr)_4.5rem_4.5rem_5rem_5rem_6.5rem]";

export function ModelTestRow({
  slug,
  providerId,
  model,
  numbers,
  prices,
}: {
  slug: string;
  providerId: string;
  model: ProviderModelRow;
  numbers: Intl.NumberFormat;
  prices: Intl.NumberFormat;
}) {
  const t = useTranslations("console.agents");
  const [state, testAction] = useActionState<ActionState, FormData>(
    testProviderModelAction,
    {},
  );
  const typeLabel = {
    text: t("modelTypeText"),
    image: t("modelTypeImage"),
    embedding: t("modelTypeEmbedding"),
    rerank: t("modelTypeRerank"),
  }[model.primaryType];
  const tags = [
    model.capabilities.includes("reasoning") && t("capabilityReasoning"),
    model.capabilities.includes("function_calling") && t("capabilityTools"),
    model.inputModalities.includes("image") && t("modalityVision"),
  ].filter((tag): tag is string => Boolean(tag));
  const cost = model.cost ?? null;
  const contextTitle =
    (
      [
        [t("contextWindow"), model.contextWindow],
        [t("maxInputTokens"), model.maxInputTokens],
      ] as const
    )
      .flatMap(([label, value]) =>
        value === null ? [] : [`${label}: ${numbers.format(value)}`],
      )
      .join("\n") || undefined;
  const meta = [
    model.contextWindow !== null &&
      `${t("contextWindow")} ${compactTokens.format(model.contextWindow)}`,
    model.maxOutputTokens !== null &&
      `${t("maxOutputTokens")} ${compactTokens.format(model.maxOutputTokens)}`,
    cost &&
      `${t("catalogInputPrice")} ${prices.format(cost.input)} · ${t("catalogOutputPrice")} ${prices.format(cost.output)}`,
  ].filter(Boolean);
  const priceCells = (
    <>
      <span className="text-right">
        {cost ? prices.format(cost.input) : "—"}
      </span>
      <span className="text-right">
        {cost ? prices.format(cost.output) : "—"}
      </span>
    </>
  );

  return (
    <article
      aria-label={model.name}
      className={`${MODEL_ROW_GRID} px-6 py-2.5 transition-colors hover:bg-muted/40`}
    >
      <div className="flex min-w-0 items-center gap-3">
        <span
          role="img"
          aria-label={typeLabel}
          className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/50 text-muted-foreground"
        >
          <ModelTypeIcon type={model.primaryType} />
        </span>
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
            <span className="min-w-0 max-w-full truncate text-sm font-medium text-foreground">
              {model.name}
            </span>
            {tags.map((tag) => (
              <span
                key={tag}
                className="shrink-0 rounded-lg px-1.5 py-px text-[10px] leading-4 text-muted-foreground ring-1 ring-inset ring-border"
              >
                {tag}
              </span>
            ))}
          </div>
          {model.name !== model.modelId ? (
            <p className="truncate font-mono text-[11px] text-muted-foreground">
              {model.modelId}
            </p>
          ) : null}
          {meta.length ? (
            <p className="text-[11px] tabular-nums text-muted-foreground xl:hidden">
              {meta.join(" · ")}
            </p>
          ) : null}
          {state.error ? (
            <ActionMessage state={state} />
          ) : state.savedAt ? (
            <p className="mt-1 text-xs text-muted-foreground" role="status">
              {t("modelAvailable")}
            </p>
          ) : null}
        </div>
      </div>
      <span
        title={contextTitle}
        className="hidden text-right text-xs tabular-nums text-foreground xl:block"
      >
        {model.contextWindow === null
          ? "—"
          : compactTokens.format(model.contextWindow)}
      </span>
      <span
        title={
          model.maxOutputTokens === null
            ? undefined
            : numbers.format(model.maxOutputTokens)
        }
        className="hidden text-right text-xs tabular-nums text-foreground xl:block"
      >
        {model.maxOutputTokens === null
          ? "—"
          : compactTokens.format(model.maxOutputTokens)}
      </span>
      <span className="hidden grid-cols-2 gap-x-3 text-xs tabular-nums text-foreground xl:col-span-2 xl:grid">
        {priceCells}
      </span>
      <div className="flex shrink-0 items-center justify-end gap-0.5">
        {model.primaryType === "text" ? (
          <form action={testAction}>
            <input type="hidden" name="workspace" value={slug} />
            <input type="hidden" name="providerId" value={providerId} />
            <input type="hidden" name="model" value={model.modelId} />
            <SubmitButton
              error={state.error}
              pendingLabel=""
              savedLabel=""
              ariaLabel={t("testModel")}
              variant="ghost"
              size="icon"
              icon={<FlaskConical className="size-3.5" />}
            >
              {null}
            </SubmitButton>
          </form>
        ) : null}
        <EditModelDialog
          slug={slug}
          providerId={providerId}
          initialModel={model}
        />
        <DeleteModelForm
          slug={slug}
          providerId={providerId}
          modelId={model.modelId}
        />
      </div>
    </article>
  );
}
