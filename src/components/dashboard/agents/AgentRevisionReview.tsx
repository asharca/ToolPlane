"use client";

import { useTranslations } from "next-intl";
import {
  Alert,
  AlertContent,
  AlertDescription,
  AlertIcon,
} from "@/components/motion/alert";
import type { ModelSelection } from "@/components/dashboard/models/ModelPicker";
import type { AgentPermissionAddition } from "@/lib/agents/permission-additions";
import type { AgentRevisionConfig } from "@/lib/agents/revision-types";
import { agentBuiltinFeatureForTool } from "@/lib/agents/runtime-kind";
import type { AgentRevisionDiff } from "@/lib/revisions/config-diff";
import { RevisionFileDiff } from "../RevisionFileDiff";
import type { FallbackModelRow } from "./AgentModelRoutingSettings";
import type { AgentPiPackageOption } from "./AgentSettingsForm";

/** A prepared revision awaiting the owner's review before it is published. */
export type AgentRevisionReviewDraft = {
  expectedRevisionId: string | null;
  config: AgentRevisionConfig;
  additions: AgentPermissionAddition[];
  diff: AgentRevisionDiff;
  fallbackRows: Record<"before" | "after", FallbackModelRow[]>;
};

export function AgentRevisionReview({
  review,
  appliedConfig,
  providers,
  piPackages,
}: {
  review: AgentRevisionReviewDraft;
  appliedConfig: AgentRevisionConfig | null;
  providers: ReadonlyArray<{ id: string; name: string }>;
  piPackages: AgentPiPackageOption[];
}) {
  const t = useTranslations("console.agents");
  const r = useTranslations("console.agents.revisions");
  const diffT = useTranslations("console.revisionDiff");
  function modelLabel(selection: ModelSelection | null | undefined) {
    if (!selection) return t("modelRouting.usePrimary");
    const providerName = providers.find(
      (item) => item.id === selection.providerId,
    )?.name;
    return `${providerName ?? selection.providerId} / ${selection.model}`;
  }
  const beforeFallbacks = review.fallbackRows.before
    .map((item) =>
      item.selection
        ? `${item.selection.providerId}/${item.selection.model}`
        : "",
    )
    .filter(Boolean)
    .join(",");
  const afterFallbacks = review.fallbackRows.after
    .map((item) =>
      item.selection
        ? `${item.selection.providerId}/${item.selection.model}`
        : "",
    )
    .filter(Boolean)
    .join(",");
  const hasModelRoutingChanges =
    !appliedConfig ||
    appliedConfig.providerId !== review.config.providerId ||
    appliedConfig.model !== review.config.model ||
    beforeFallbacks !== afterFallbacks ||
    (["compaction", "title"] as const).some(
      (role) =>
        appliedConfig.roleModels?.[role]?.providerId !==
          review.config.roleModels?.[role]?.providerId ||
        appliedConfig.roleModels?.[role]?.model !==
          review.config.roleModels?.[role]?.model,
    );
  return (
    <section
      aria-label={r("review")}
      className="space-y-3 rounded-lg border border-border p-4"
    >
      <h4 className="font-semibold">{r("review")}</h4>
      {review.additions.length ? (
        <Alert variant="warning">
          <AlertIcon />
          <AlertContent className="space-y-2">
            <AlertDescription>{r("reviewHelp")}</AlertDescription>
            <ul className="space-y-2 text-sm text-foreground">
              {review.additions.map((addition) => {
                const nativeDelegation =
                  addition.kind === "delegation" &&
                  addition.resourceId === "native";
                const nativeValues = nativeDelegation
                  ? addition.values.map((value) => {
                      if (value === "native")
                        return t("subagentResources.nativeMode");
                      if (value.startsWith("maxConcurrency:"))
                        return t("subagentResources.reviewConcurrency", {
                          value: value.split(":")[1],
                        });
                      if (value.startsWith("maxDepth:"))
                        return t("subagentResources.reviewDepth", {
                          value: value.split(":")[1],
                        });
                      return value;
                    })
                  : [];
                const resource =
                  addition.kind === "package"
                    ? piPackages.find(
                        (option) =>
                          option.marketInstallId === addition.resourceId,
                      )?.name
                    : null;
                return (
                  <li key={`${addition.kind}:${addition.resourceId}`}>
                    <span className="font-medium">
                      {nativeDelegation
                        ? t("subagentResources.nativeMode")
                        : addition.kind === "delegation" &&
                            review.config.subagents?.some(
                              (pin) => pin.subagentId === addition.resourceId,
                            )
                          ? r("permissionKinds.subagent")
                          : r(`permissionKinds.${addition.kind}`)}
                    </span>
                    <p className="break-words text-muted-foreground">
                      {resource ? `${resource}: ` : ""}
                      {nativeDelegation
                        ? nativeValues.join(", ")
                        : addition.kind === "environment"
                          ? addition.values
                              .map((value) => r(`environmentChanges.${value}`))
                              .join("、")
                          : addition.kind === "package" && resource
                            ? r("packageCode")
                            : addition.kind === "delegation" &&
                                ["inbound", "outbound"].includes(
                                  addition.resourceId,
                                )
                              ? r(`delegationChanges.${addition.resourceId}`)
                              : addition.kind === "builtin"
                                ? [
                                    ...new Set(
                                      addition.values.map((tool) => {
                                        const feature =
                                          agentBuiltinFeatureForTool(tool);
                                        return feature
                                          ? t(
                                              `builtinFeatures.${feature.id}.name`,
                                            )
                                          : tool;
                                      }),
                                    ),
                                  ].join("、")
                                : addition.values.join(", ")}
                    </p>
                  </li>
                );
              })}
            </ul>
          </AlertContent>
        </Alert>
      ) : null}
      <p className="text-sm text-muted-foreground">{diffT("reviewHelp")}</p>
      {hasModelRoutingChanges ? (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-muted-foreground">
                <th scope="col" className="p-2">
                  {t("model")}
                </th>
                <th scope="col" className="p-2">
                  {t("modelRouting.before")}
                </th>
                <th scope="col" className="p-2">
                  {t("modelRouting.after")}
                </th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row" className="p-2 font-medium">
                  {t("model")}
                </th>
                {[appliedConfig, review.config].map((config, index) => (
                  <td
                    key={index === 0 ? "before" : "after"}
                    className="break-words p-2"
                  >
                    {config?.providerId && config.model
                      ? modelLabel({
                          providerId: config.providerId,
                          model: config.model,
                        })
                      : t("none")}
                  </td>
                ))}
              </tr>
              <tr>
                <th scope="row" className="p-2 align-top font-medium">
                  {t("modelRouting.fallbackModels")}
                </th>
                {[appliedConfig, review.config].map((config, index) => (
                  <td
                    key={index === 0 ? "before" : "after"}
                    className="break-words p-2 align-top"
                  >
                    {config?.fallbackModels?.length ? (
                      <ol className="list-inside list-decimal space-y-1">
                        {review.fallbackRows[
                          index === 0 ? "before" : "after"
                        ].map((item) => (
                          <li key={item.id}>{modelLabel(item.selection)}</li>
                        ))}
                      </ol>
                    ) : (
                      t("none")
                    )}
                  </td>
                ))}
              </tr>
              {(["compaction", "title"] as const).map((role) => (
                <tr key={role}>
                  <th scope="row" className="p-2 font-medium">
                    {t(`modelRouting.${role}`)}
                  </th>
                  <td className="break-words p-2">
                    {modelLabel(appliedConfig?.roleModels?.[role])}
                  </td>
                  <td className="break-words p-2">
                    {modelLabel(review.config.roleModels?.[role])}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <RevisionFileDiff diff={review.diff} />
    </section>
  );
}
