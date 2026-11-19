"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { FlaskConical } from "lucide-react";
import { Tooltip } from "@/components/motion/tooltip";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import {
  testProviderModelAction,
  type ActionState,
} from "@/lib/agents/actions";
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

function ModelPriceDetails({
  cost,
  numbers,
  prices,
}: {
  cost: NonNullable<ProviderModelRow["cost"]>;
  numbers: Intl.NumberFormat;
  prices: Intl.NumberFormat;
}) {
  const t = useTranslations("console.agents");
  const rows = [
    { label: t("catalogBasePrice"), rates: cost },
    ...(cost.tiers ?? []).map((tier) => ({
      label: t("catalogTierAbove", {
        tokens: numbers.format(tier.inputTokensAbove),
      }),
      rates: tier,
    })),
  ];
  return (
    <span className="block space-y-2 text-left text-xs">
      <span className="block text-muted-foreground">
        {t("catalogPriceUnit")}
      </span>
      {rows.map(({ label, rates }) => (
        <span key={label} className="block">
          {rows.length > 1 ? (
            <span className="block font-medium">{label}</span>
          ) : null}
          {(
            [
              ["catalogInputPrice", rates.input],
              ["catalogOutputPrice", rates.output],
              ["catalogCacheReadPrice", rates.cacheRead],
              ["catalogCacheWritePrice", rates.cacheWrite],
            ] as const
          ).map(([field, price]) => (
            <span key={field} className="flex justify-between gap-4">
              <span className="text-muted-foreground">{t(field)}</span>
              <span className="tabular-nums">{prices.format(price)}</span>
            </span>
          ))}
        </span>
      ))}
    </span>
  );
}

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
  const hasPriceDetails = Boolean(
    cost && (cost.cacheRead || cost.cacheWrite || cost.tiers?.length),
  );

  return (
    <article
      aria-label={model.name}
      className={`${MODEL_ROW_GRID} px-4 py-2.5 transition-colors hover:bg-muted/40`}
    >
      <div className="flex min-w-0 items-center gap-3">
        <Tooltip content={typeLabel}>
          <span
            role="img"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: This labeled model icon is a keyboard-focusable tooltip trigger, not an action.
            tabIndex={0}
            aria-label={typeLabel}
            className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/50 text-muted-foreground"
          >
            <ModelTypeIcon type={model.primaryType} />
          </span>
        </Tooltip>
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
      {hasPriceDetails && cost ? (
        <Tooltip
          content={
            <ModelPriceDetails cost={cost} numbers={numbers} prices={prices} />
          }
          wrapperClassName="hidden xl:col-span-2 xl:grid"
        >
          <span
            // biome-ignore lint/a11y/noNoninteractiveTabindex: The price cells are a keyboard-focusable trigger for the full price table.
            tabIndex={0}
            className="grid cursor-help grid-cols-2 gap-x-3 text-xs tabular-nums text-foreground underline decoration-border decoration-dotted underline-offset-4"
          >
            {priceCells}
          </span>
        </Tooltip>
      ) : (
        <span className="hidden grid-cols-2 gap-x-3 text-xs tabular-nums text-foreground xl:col-span-2 xl:grid">
          {priceCells}
        </span>
      )}
      <div className="flex shrink-0 items-center justify-end gap-0.5">
        {model.primaryType === "text" ? (
          <form action={testAction}>
            <input type="hidden" name="workspace" value={slug} />
            <input type="hidden" name="providerId" value={providerId} />
            <input type="hidden" name="model" value={model.modelId} />
            <Tooltip content={t("testModel")}>
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
            </Tooltip>
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
