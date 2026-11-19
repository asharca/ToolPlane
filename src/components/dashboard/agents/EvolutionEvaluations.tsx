"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/motion/button";
import { FormCheckbox } from "@/components/ui/FormCheckbox";
import { notify } from "../Toaster";
import type {
  EvaluationDto,
  EvolutionCaseDto,
  ProposalDto,
} from "@/lib/agents/evolution/contracts";
import {
  Empty,
  Failure,
  Field,
  inputClass,
  RecordCard,
  Section,
  type EvolutionFormat,
  type Mutation,
} from "./evolution-ui";

type Criterion = NonNullable<EvolutionCaseDto["criterion"]>;

export function EvolutionEvaluations({
  cases,
  proposals,
  evaluations,
  busy,
  canReview,
  canExecute,
  mutate,
  format,
}: {
  cases: EvolutionCaseDto[];
  proposals: ProposalDto[];
  evaluations: EvaluationDto[];
  busy: boolean;
  canReview: boolean;
  canExecute: boolean;
  mutate: Mutation;
  format: EvolutionFormat;
}) {
  const t = useTranslations("console.evolution");
  const [editing, setEditing] = useState<EvolutionCaseDto | null>(null);
  const [name, setName] = useState("");
  const [input, setInput] = useState("");
  const [expected, setExpected] = useState("");
  const [criterion, setCriterion] = useState<Criterion>("contains");
  const [proposalId, setProposalId] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [recordedTools, setRecordedTools] = useState("[]");
  const [requiredTools, setRequiredTools] = useState("");
  const candidates = proposals.filter(
    (item) => item.status === "approved" && item.candidateRevisionId,
  );
  function resetCase() {
    setEditing(null);
    setName("");
    setInput("");
    setExpected("");
    setCriterion("contains");
    setRecordedTools("[]");
    setRequiredTools("");
  }
  async function saveCase() {
    let recordings: unknown;
    try {
      recordings = JSON.parse(recordedTools);
      if (!Array.isArray(recordings)) throw new Error("INVALID_REQUEST");
    } catch {
      notify(t("recordingJsonInvalid"), { severity: "error" });
      return;
    }
    if (
      await mutate("cases", editing ? "PATCH" : "POST", {
        ...(editing ? { id: editing.id } : {}),
        name,
        input,
        expected,
        criterion,
        recordedTools: recordings,
        requiredTools: requiredTools
          .split("\n")
          .map((tool) => tool.trim())
          .filter(Boolean),
      })
    )
      resetCase();
  }
  const selectedCaseIds = selected.filter((id) =>
    cases.some((item) => item.id === id),
  );
  return (
    <div className="space-y-8">
      <Section title={t("runTitle")}>
        {candidates.length ? (
          <>
            <Field label={t("candidate")}>
              <select
                className={inputClass}
                value={proposalId}
                onChange={(event) => setProposalId(event.target.value)}
              >
                <option value="">{t("chooseCandidate")}</option>
                {candidates.map((item) => (
                  <option key={item.id} value={item.id}>
                    {format.version(item.candidateRevisionId)} · {item.title}
                  </option>
                ))}
              </select>
            </Field>
            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="button"
                disabled={
                  busy || !canExecute || !proposalId || !selectedCaseIds.length
                }
                onClick={() =>
                  void mutate("evaluations", "POST", {
                    proposalId,
                    caseIds: selectedCaseIds,
                  })
                }
              >
                {t("runEvaluation")}
              </Button>
              <span className="text-sm text-muted-foreground">
                {t("selectedCases", { count: selectedCaseIds.length })}
              </span>
            </div>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">{t("noCandidate")}</p>
        )}
      </Section>
      <Section title={t("cases")}>
        <Empty count={cases.length} />
        {cases.map((item) => (
          <RecordCard
            key={item.id}
            title={item.name}
            meta={t(`criteria.${item.criterion ?? "exact"}`)}
          >
            <p className="whitespace-pre-wrap break-words text-sm">
              {item.input}
            </p>
            <details>
              <summary className="cursor-pointer text-sm">
                {t(`expected.${item.criterion ?? "exact"}`)}
              </summary>
              <pre className="whitespace-pre-wrap break-words text-xs">
                {item.expected}
              </pre>
            </details>
            {item.requiredTools?.length ? (
              <p className="break-words text-xs">
                {t("requiredTools")}: {item.requiredTools.join(", ")}
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              <FormCheckbox
                disabled={busy || !canExecute}
                checked={selected.includes(item.id)}
                onCheckedChange={(checked) =>
                  setSelected((previous) =>
                    checked
                      ? [...previous, item.id]
                      : previous.filter((id) => id !== item.id),
                  )
                }
                label={t("selectCase")}
              />
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={busy || !canReview}
                onClick={() => {
                  setEditing(item);
                  setName(item.name);
                  setInput(item.input);
                  setExpected(item.expected);
                  setCriterion(item.criterion ?? "exact");
                  setRecordedTools(
                    JSON.stringify(item.recordedTools ?? [], null, 2),
                  );
                  setRequiredTools((item.requiredTools ?? []).join("\n"));
                }}
              >
                {t("edit")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busy || !canReview}
                onClick={() => setDeleteId(item.id)}
              >
                {t("delete")}
              </Button>
            </div>
            {deleteId === item.id ? (
              <div className="space-y-2">
                <p className="text-sm">{t("deleteCaseConfirm")}</p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    disabled={busy || !canReview}
                    onClick={async () => {
                      if (
                        await mutate(
                          `cases?id=${encodeURIComponent(item.id)}`,
                          "DELETE",
                        )
                      ) {
                        setDeleteId(null);
                        setSelected((previous) =>
                          previous.filter((id) => id !== item.id),
                        );
                        if (editing?.id === item.id) resetCase();
                      }
                    }}
                  >
                    {t("confirmDelete")}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setDeleteId(null)}
                  >
                    {t("cancel")}
                  </Button>
                </div>
              </div>
            ) : null}
          </RecordCard>
        ))}
      </Section>
      <Section title={editing ? t("edit") : t("newCase")}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void saveCase();
          }}
        >
          <fieldset className="min-w-0 space-y-3" disabled={busy || !canReview}>
            <Field label={t("caseName")}>
              <input
                className={inputClass}
                required
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Field label={t("caseInput")}>
              <textarea
                className={inputClass}
                required
                rows={3}
                value={input}
                onChange={(event) => setInput(event.target.value)}
              />
            </Field>
            <Field label={t("criterion")}>
              <select
                className={inputClass}
                value={criterion}
                onChange={(event) =>
                  setCriterion(event.target.value as Criterion)
                }
              >
                {(["contains", "exact", "rubric"] as const).map((value) => (
                  <option key={value} value={value}>
                    {t(`criteria.${value}`)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t(`expected.${criterion}`)}>
              <textarea
                className={inputClass}
                required
                rows={3}
                value={expected}
                onChange={(event) => setExpected(event.target.value)}
              />
            </Field>
            <details className="space-y-3">
              <summary className="cursor-pointer text-sm font-medium">
                {t("toolSimulation")}
              </summary>
              <div className="mt-3 space-y-3">
                <Field label={t("requiredTools")}>
                  <textarea
                    className={inputClass}
                    rows={2}
                    value={requiredTools}
                    onChange={(event) => setRequiredTools(event.target.value)}
                  />
                </Field>
                <Field label={t("recordedTools")} help={t("recordedToolsHelp")}>
                  <textarea
                    className={`${inputClass} font-mono`}
                    rows={6}
                    value={recordedTools}
                    onChange={(event) => setRecordedTools(event.target.value)}
                    spellCheck={false}
                  />
                </Field>
              </div>
            </details>
            <div className="flex gap-2">
              <Button type="submit">
                {editing ? t("save") : t("addCase")}
              </Button>
              {editing ? (
                <Button type="button" variant="secondary" onClick={resetCase}>
                  {t("cancel")}
                </Button>
              ) : null}
            </div>
          </fieldset>
        </form>
      </Section>
      <Section title={t("results")}>
        <Empty count={evaluations.length} />
        {evaluations.map((evaluation) => (
          <RecordCard
            key={evaluation.id}
            title={`${proposals.find((item) => item.id === evaluation.proposalId)?.title ?? t("candidate")} · ${t(`status.${evaluation.status}`)}`}
            meta={`${t("baseline")} ${format.version(evaluation.baselineRevisionId)} · ${t("candidate")} ${format.version(evaluation.candidateRevisionId)} · ${format.date(evaluation.createdAt)}`}
          >
            {evaluation.pareto ? (
              <p className="text-sm font-medium">
                {t(`verdict.${evaluation.pareto}`)}
              </p>
            ) : null}
            {evaluation.failureCode ? (
              <Failure text={format.failure(evaluation.failureCode)} />
            ) : null}
            {evaluation.results.length ? (
              <div className="max-w-full overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr>
                      {[
                        "caseName",
                        "variant",
                        "score",
                        "costLabel",
                        "output",
                      ].map((key) => (
                        <th key={key} scope="col" className="p-2">
                          {t(key)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {evaluation.results.map((result) => (
                      <tr key={result.id} className="border-t border-border">
                        <td className="p-2">
                          {cases.find((item) => item.id === result.caseId)
                            ?.name ?? result.caseId}
                        </td>
                        <td className="p-2">{t(result.variant)}</td>
                        <td className="p-2 tabular-nums">
                          {format.score(result.quality)}
                        </td>
                        <td className="p-2 tabular-nums">
                          {format.money(result.costMicros)}
                          {result.judgeCostMicros &&
                          result.judgeCostMicros !== "0" ? (
                            <p className="text-muted-foreground">
                              {t("judgeCost", {
                                value: format.money(result.judgeCostMicros),
                              })}
                            </p>
                          ) : null}
                        </td>
                        <td className="min-w-40 max-w-80 p-2">
                          <details>
                            <summary
                              className={`cursor-pointer ${result.failureCode ? "text-destructive" : ""}`}
                            >
                              {result.failureCode
                                ? format.failure(result.failureCode)
                                : t("viewOutput")}
                            </summary>
                            <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words">
                              {result.output}
                            </pre>
                            <p>
                              {t("tokens", {
                                input: result.inputTokens,
                                output: result.outputTokens,
                              })}
                            </p>
                          </details>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
            {evaluation.excludedCapabilities?.length ? (
              <p className="text-xs text-muted-foreground">
                {t("excludedCapabilities")}:{" "}
                {evaluation.excludedCapabilities
                  .map((capability) =>
                    t.has(`excluded.${capability}`)
                      ? t(`excluded.${capability}`)
                      : capability,
                  )
                  .join("、")}
              </p>
            ) : null}
          </RecordCard>
        ))}
      </Section>
    </div>
  );
}
