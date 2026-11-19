"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/motion/button";
import { FormCheckbox } from "@/components/ui/FormCheckbox";
import type {
  EvaluationDto,
  ProposalDto,
  RolloutDto,
} from "@/lib/agents/evolution/contracts";
import {
  Field,
  inputClass,
  Notice,
  RecordCard,
  Section,
  type EvolutionFormat,
  type Mutation,
} from "./evolution-ui";

const ROLLOUT_METRICS = [
  "tasks",
  "succeeded",
  "failed",
  "successRate",
  "toolCalls",
  "toolFailures",
  "averageCostMicros",
  "feedbackPositive",
  "feedbackNegative",
] as const;

export function EvolutionRollout({
  rollout,
  evaluations,
  proposals,
  currentRevisionId,
  busy,
  canExecute,
  mutate,
  format,
}: {
  rollout: RolloutDto | null;
  evaluations: EvaluationDto[];
  proposals: ProposalDto[];
  currentRevisionId: string | null;
  busy: boolean;
  canExecute: boolean;
  mutate: Mutation;
  format: EvolutionFormat;
}) {
  const t = useTranslations("console.evolution");
  const [evaluationId, setEvaluationId] = useState("");
  const [percentage, setPercentage] = useState("10");
  const [confirm, setConfirm] = useState<
    "stop" | "promote" | "rollback" | null
  >(null);
  const [isolationRisk, setIsolationRisk] = useState(false);
  const completed = evaluations.filter((item) => item.status === "succeeded");
  const evaluation = completed.find((item) => item.id === evaluationId);
  const active = rollout?.status === "active";
  const staleRollout =
    active && rollout.baselineRevisionId !== currentRevisionId;
  return (
    <section className="space-y-6">
      {rollout ? (
        <RecordCard
          title={`${t(`status.${rollout.status}`)} · ${t("percentageValue", { value: rollout.percentage })}`}
          meta={`${t("baseline")} ${format.version(rollout.baselineRevisionId)} · ${t("candidate")} ${format.version(rollout.candidateRevisionId)} · ${format.date(rollout.createdAt)}`}
        >
          {staleRollout ? <Notice>{t("staleRollout")}</Notice> : null}
          {rollout.metrics ? (
            <>
              <p className="text-sm font-medium">
                {t(`recommendation.${rollout.metrics.recommendation}`)}
                <span className="font-normal text-muted-foreground">
                  {" "}
                  · {t(`sample.${rollout.metrics.sampleStatus}`)}
                </span>
              </p>
              <div className="max-w-full overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr>
                      <th scope="col" className="p-2">
                        {t("metric")}
                      </th>
                      <th scope="col" className="p-2">
                        {t("baseline")}{" "}
                        {format.version(rollout.baselineRevisionId)}
                      </th>
                      <th scope="col" className="p-2">
                        {t("candidate")}{" "}
                        {format.version(rollout.candidateRevisionId)}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {ROLLOUT_METRICS.map((metric) => (
                      <tr key={metric} className="border-t border-border">
                        <th scope="row" className="p-2 font-normal">
                          {t(`metrics.${metric}`)}
                        </th>
                        {(["baseline", "candidate"] as const).map((variant) => {
                          const value = rollout.metrics?.[variant][metric];
                          return (
                            <td key={variant} className="p-2 tabular-nums">
                              {value == null
                                ? t("unavailable")
                                : metric === "successRate"
                                  ? t("successRateValue", {
                                      value: Number(value),
                                    })
                                  : metric === "averageCostMicros"
                                    ? format.money(value)
                                    : value}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
          <p className="text-sm text-muted-foreground">{t("rollbackAdvice")}</p>
          <div className="flex flex-wrap gap-2">
            {(active
              ? (["stop", "promote", "rollback"] as const)
              : rollout.status === "promoted" || rollout.status === "stopped"
                ? (["rollback"] as const)
                : []
            ).map((action) => (
              <Button
                key={action}
                type="button"
                variant={action === "promote" ? "primary" : "secondary"}
                size="sm"
                disabled={busy || !canExecute || !currentRevisionId}
                onClick={() => {
                  setConfirm(action);
                  setIsolationRisk(false);
                }}
              >
                {t(action)}
              </Button>
            ))}
          </div>
          {confirm ? (
            <div className="space-y-3 rounded-lg bg-muted p-3">
              <p className="text-sm">{t(`confirm.${confirm}`)}</p>
              {confirm === "promote" ? (
                <FormCheckbox
                  checked={isolationRisk}
                  onCheckedChange={setIsolationRisk}
                  disabled={busy || !canExecute}
                  label={t("isolationRiskConsent")}
                />
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  disabled={
                    busy ||
                    !canExecute ||
                    !currentRevisionId ||
                    (confirm === "promote" && !isolationRisk)
                  }
                  onClick={async () => {
                    if (
                      await mutate("rollout", "PATCH", {
                        id: rollout.id,
                        action: confirm,
                        expectedDefaultRevisionId: currentRevisionId,
                        ...(confirm === "promote"
                          ? { acknowledgeIsolationRisk: isolationRisk }
                          : {}),
                      })
                    )
                      setConfirm(null);
                  }}
                >
                  {t("confirmAction")}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setConfirm(null)}
                >
                  {t("cancel")}
                </Button>
              </div>
            </div>
          ) : null}
        </RecordCard>
      ) : null}
      {!active ? (
        <Section title={t("startRollout")}>
          {completed.length ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (evaluation)
                  void mutate("rollout", "POST", {
                    proposalId: evaluation.proposalId,
                    evaluationId,
                    percentage: Number(percentage),
                  });
              }}
            >
              <fieldset
                className="min-w-0 space-y-3"
                disabled={busy || !canExecute}
              >
                <Field label={t("successfulEvaluation")}>
                  <select
                    className={inputClass}
                    required
                    value={evaluationId}
                    onChange={(event) => setEvaluationId(event.target.value)}
                  >
                    <option value="">{t("chooseEvaluation")}</option>
                    {completed.map((item) => (
                      <option key={item.id} value={item.id}>
                        {format.version(item.candidateRevisionId)} ·{" "}
                        {proposals.find(
                          (proposal) => proposal.id === item.proposalId,
                        )?.title ?? t("candidate")}
                        {item.pareto
                          ? ` · ${t(`verdictShort.${item.pareto}`)}`
                          : ""}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={t("percentage")}>
                  <input
                    className={inputClass}
                    type="number"
                    required
                    min={1}
                    max={100}
                    value={percentage}
                    onChange={(event) => setPercentage(event.target.value)}
                  />
                </Field>
                <Button type="submit" disabled={!evaluation}>
                  {t("startRollout")}
                </Button>
              </fieldset>
            </form>
          ) : (
            <p className="text-sm text-muted-foreground">{t("noEvaluation")}</p>
          )}
        </Section>
      ) : null}
    </section>
  );
}
