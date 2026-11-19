"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/motion/button";
import { notify } from "../Toaster";
import type {
  EpisodeDto,
  EvaluationDto,
  EvolutionCaseDto,
  EvolutionOverviewDto,
  FeedbackDto,
  PlaybookDto,
  ProposalDto,
  ReflectionDto,
  RolloutDto,
} from "@/lib/agents/evolution/contracts";
import { evolutionErrorCode, evolutionRequest } from "./evolution-client";
import {
  Empty,
  Failure,
  RecordCard,
  Section,
  useEvolutionFormat,
  type Mutation,
} from "./evolution-ui";
import { EvolutionSettings } from "./EvolutionSettings";
import { EvolutionMemory } from "./EvolutionMemory";
import { EvolutionProposals } from "./EvolutionProposals";
import { EvolutionEvaluations } from "./EvolutionEvaluations";
import { EvolutionRollout } from "./EvolutionRollout";

const STEPS = [
  "settings",
  "experience",
  "memory",
  "proposals",
  "evaluations",
  "rollout",
] as const;
type Step = (typeof STEPS)[number];

type EvolutionSnapshot = {
  overview: EvolutionOverviewDto;
  episodes: EpisodeDto[];
  feedback: FeedbackDto[];
  playbook: PlaybookDto[];
  proposals: ProposalDto[];
  cases: EvolutionCaseDto[];
  evaluations: EvaluationDto[];
  rollout: RolloutDto | null;
  reflections: ReflectionDto[];
};
type ListResource =
  | "episodes"
  | "feedback"
  | "playbook"
  | "proposals"
  | "cases"
  | "evaluations"
  | "reflections";

const STEP_RESOURCES: Record<Step, ListResource[]> = {
  settings: ["reflections"],
  experience: ["episodes", "feedback"],
  memory: ["playbook"],
  proposals: ["proposals"],
  evaluations: ["cases", "evaluations"],
  rollout: ["evaluations"],
};
const RESOURCE_LABELS: Record<ListResource, string> = {
  episodes: "episodes",
  feedback: "feedback",
  playbook: "steps.memory",
  proposals: "steps.proposals",
  cases: "cases",
  evaluations: "results",
  reflections: "reflectionHistory",
};
const NO_REVISIONS: EvolutionOverviewDto["revisions"] = [];

// Reads never change state, so any failure other than an access problem gets the
// plain "could not load" message, not the warning reserved for mutations.
const LOAD_ERROR_CODES: Record<string, true> = {
  UNAUTHORIZED: true,
  NOT_FOUND: true,
  FORBIDDEN: true,
};
function loadFailure(cause: unknown) {
  const code = evolutionErrorCode(cause);
  return Object.hasOwn(LOAD_ERROR_CODES, code) ? code : "LOAD_FAILED";
}

function mergeRecords<T extends { id: string }>(latest: T[], previous: T[]) {
  const ids = new Set(latest.map((item) => item.id));
  return [...latest, ...previous.filter((item) => !ids.has(item.id))];
}

export function AgentEvolutionPanel({
  agentId,
  currentRevisionId,
}: {
  agentId: string;
  currentRevisionId: string | null;
}) {
  const t = useTranslations("console.evolution");
  const router = useRouter();
  const base = `/api/v1/agents/${encodeURIComponent(agentId)}/evolution`;
  const [snapshot, setSnapshot] = useState<EvolutionSnapshot | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Step>("settings");
  const [cursors, setCursors] = useState<
    Partial<Record<ListResource, string | null>>
  >({});
  const format = useEvolutionFormat(
    snapshot?.overview.revisions ?? NO_REVISIONS,
  );
  const errorText = (code: string) =>
    t.has(`errors.${code}`)
      ? t(`errors.${code}`)
      : t("errors.EVOLUTION_FAILED");
  const load = useCallback(
    async (signal?: AbortSignal, preservePages = false) => {
      const next: Partial<Record<ListResource, string | null>> = {};
      const page = <K extends ListResource>(resource: K) =>
        evolutionRequest<EvolutionSnapshot[K]>(
          `${base}/${resource}`,
          "GET",
          undefined,
          signal,
          (cursor) => {
            next[resource] = cursor;
          },
        );
      const [
        overview,
        episodes,
        feedback,
        playbook,
        proposals,
        cases,
        evaluations,
        rollout,
        reflections,
      ] = await Promise.all([
        evolutionRequest<EvolutionOverviewDto>(
          `${base}/settings`,
          "GET",
          undefined,
          signal,
        ),
        page("episodes"),
        page("feedback"),
        page("playbook"),
        page("proposals"),
        page("cases"),
        page("evaluations"),
        evolutionRequest<RolloutDto | null>(
          `${base}/rollout`,
          "GET",
          undefined,
          signal,
        ),
        page("reflections"),
      ]);
      setSnapshot((previous) =>
        preservePages && previous
          ? {
              overview,
              rollout,
              episodes: mergeRecords(episodes, previous.episodes),
              feedback: mergeRecords(feedback, previous.feedback),
              playbook: mergeRecords(playbook, previous.playbook),
              proposals: mergeRecords(proposals, previous.proposals),
              cases: mergeRecords(cases, previous.cases),
              evaluations: mergeRecords(evaluations, previous.evaluations),
              reflections: mergeRecords(reflections, previous.reflections),
            }
          : {
              overview,
              episodes,
              feedback,
              playbook,
              proposals,
              cases,
              evaluations,
              rollout,
              reflections,
            },
      );
      if (!preservePages) setCursors(next);
    },
    [base],
  );
  async function loadMore<K extends ListResource>(resource: K) {
    const cursor = cursors[resource];
    if (!cursor || busy || loading) return;
    setLoading(true);
    try {
      const items = await evolutionRequest<EvolutionSnapshot[K]>(
        `${base}/${resource}?cursor=${encodeURIComponent(cursor)}`,
        "GET",
        undefined,
        undefined,
        (nextCursor) =>
          setCursors((previous) => ({ ...previous, [resource]: nextCursor })),
      );
      setSnapshot((previous) =>
        previous
          ? {
              ...previous,
              [resource]: [
                ...previous[resource],
                ...items.filter(
                  (item) =>
                    !previous[resource].some(
                      (existing) => existing.id === item.id,
                    ),
                ),
              ],
            }
          : previous,
      );
    } catch (cause) {
      setError(loadFailure(cause));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    load(controller.signal)
      .catch((cause) => {
        if (!controller.signal.aborted) setError(loadFailure(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [load]);
  const queued =
    snapshot?.reflections.some(
      (item) => item.status === "queued" || item.status === "running",
    ) ||
    snapshot?.evaluations.some(
      (item) => item.status === "queued" || item.status === "running",
    );
  useEffect(() => {
    if (!queued || busy || loading) return;
    const controller = new AbortController();
    const poll = async () => {
      try {
        await load(controller.signal, true);
      } catch (cause) {
        if (!controller.signal.aborted) setError(loadFailure(cause));
      } finally {
        if (!controller.signal.aborted) timer = window.setTimeout(poll, 5000);
      }
    };
    let timer = window.setTimeout(poll, 5000);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [queued, busy, loading, load]);
  async function refresh() {
    setLoading(true);
    setError("");
    try {
      await load();
    } catch (cause) {
      setError(loadFailure(cause));
    } finally {
      setLoading(false);
    }
  }
  const mutate: Mutation = async (path, method, body) => {
    if (busy) return false;
    setBusy(true);
    setError("");
    let committed = false;
    try {
      await evolutionRequest(`${base}/${path}`, method, body);
      committed = true;
      await load();
      router.refresh();
      notify(t("saved"));
      return true;
    } catch (cause) {
      const code = committed ? "REFRESH_FAILED" : evolutionErrorCode(cause);
      setError(code);
      notify(errorText(code), { severity: "error" });
      return false;
    } finally {
      setBusy(false);
    }
  };
  const review = snapshot?.overview.permissions.canReview ?? false;
  const execute = snapshot?.overview.permissions.canExecute ?? false;
  const pending: Partial<Record<Step, number>> = snapshot
    ? {
        memory: snapshot.playbook.filter((item) => item.status === "pending")
          .length,
        proposals: snapshot.proposals.filter(
          (item) =>
            item.status === "pending" &&
            item.baseRevisionId === currentRevisionId,
        ).length,
        evaluations: snapshot.evaluations.filter(
          (item) => item.status === "queued" || item.status === "running",
        ).length,
        rollout: snapshot.rollout?.status === "active" ? 1 : 0,
      }
    : {};
  const moreResources = STEP_RESOURCES[tab].filter(
    (resource) => cursors[resource],
  );
  return (
    <div className="min-w-0 space-y-5 px-6 py-5" aria-busy={busy || loading}>
      <header className="flex justify-end">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => void refresh()}
          disabled={busy || loading}
        >
          {t("refresh")}
        </Button>
      </header>
      <nav aria-label={t("navigation")}>
        <ol className="flex flex-wrap gap-1">
          {STEPS.map((step, index) => {
            const count = pending[step] ?? 0;
            return (
              <li key={step}>
                <Button
                  type="button"
                  size="sm"
                  variant={tab === step ? "primary" : "ghost"}
                  aria-current={tab === step ? "step" : undefined}
                  onClick={() => setTab(step)}
                >
                  <span className="tabular-nums">{index + 1}.</span>
                  {t(`steps.${step}`)}
                  {count ? (
                    <span
                      className="rounded-full bg-amber-500/20 px-1.5 text-xs tabular-nums text-amber-700 dark:text-amber-300"
                      aria-hidden="true"
                    >
                      {count}
                    </span>
                  ) : null}
                  {count ? (
                    <span className="sr-only">
                      {t("pendingCount", { count })}
                    </span>
                  ) : null}
                </Button>
              </li>
            );
          })}
        </ol>
      </nav>
      <p className="text-sm leading-6 text-muted-foreground">
        {t(`help.${tab}`)}
      </p>
      {error ? (
        <p role="alert" className="break-words text-sm text-destructive">
          {errorText(error)}
        </p>
      ) : null}
      {loading && !snapshot ? <p role="status">{t("loading")}</p> : null}
      {snapshot ? (
        <>
          {!review || !execute ? (
            <p className="text-sm text-muted-foreground">{t("readOnly")}</p>
          ) : null}
          {tab === "settings" ? (
            <div className="space-y-6">
              <EvolutionSettings
                overview={snapshot.overview}
                busy={busy}
                mutate={mutate}
                format={format}
              />
              <Section title={t("reflection")}>
                <p className="text-sm text-muted-foreground">
                  {snapshot.overview.settings.enabled
                    ? t("reflectionHelp")
                    : t("reflectionDisabled")}
                </p>
                <Button
                  type="button"
                  disabled={
                    !execute || busy || !snapshot.overview.settings.enabled
                  }
                  onClick={() => void mutate("reflections", "POST", {})}
                >
                  {t("reflect")}
                </Button>
                <h5 className="pt-2 text-sm font-medium">
                  {t("reflectionHistory")}
                </h5>
                <Empty count={snapshot.reflections.length} />
                {snapshot.reflections.map((item) => (
                  <RecordCard
                    key={item.id}
                    title={`${t(`status.${item.status}`)} · ${format.date(item.createdAt)}`}
                    meta={t("cost", { value: format.money(item.costMicros) })}
                  >
                    {item.failureCode ? (
                      <Failure text={format.failure(item.failureCode)} />
                    ) : null}
                  </RecordCard>
                ))}
              </Section>
            </div>
          ) : null}
          {tab === "experience" ? (
            <div className="space-y-6">
              <Section title={t("episodes")}>
                <Empty count={snapshot.episodes.length} />
                {snapshot.episodes.map((item) => (
                  <RecordCard
                    key={item.id}
                    title={`${t(`status.${item.outcome}`)} · ${format.date(item.createdAt)}`}
                    meta={[
                      `${t("version")} ${format.version(item.revisionId)}`,
                      t("tokens", {
                        input: item.inputTokens,
                        output: item.outputTokens,
                      }),
                      t("cost", { value: format.money(item.costMicros) }),
                      ...(item.toolCalls
                        ? [
                            t("toolCalls", {
                              calls: item.toolCalls,
                              failures: item.toolFailures ?? 0,
                            }),
                          ]
                        : []),
                    ].join(" · ")}
                  >
                    {item.summary ? (
                      <p className="line-clamp-6 whitespace-pre-wrap break-words text-sm">
                        {item.summary}
                      </p>
                    ) : null}
                    {item.failureCode ? (
                      <Failure text={format.failure(item.failureCode)} />
                    ) : null}
                    <p className="break-all text-xs text-muted-foreground">
                      {item.taskId
                        ? `${t("taskId")}: ${item.taskId}`
                        : `${t("conversationId")}: ${item.conversationId}`}
                    </p>
                  </RecordCard>
                ))}
              </Section>
              <Section title={t("feedback")}>
                <Empty count={snapshot.feedback.length} />
                {snapshot.feedback.map((item) => (
                  <RecordCard
                    key={item.id}
                    title={`${t(item.rating)} · ${format.date(item.createdAt)}`}
                    meta={`${t("conversationId")}: ${item.conversationId}`}
                  >
                    <p className="whitespace-pre-wrap break-words text-sm">
                      {item.comment || t("noComment")}
                    </p>
                  </RecordCard>
                ))}
              </Section>
            </div>
          ) : null}
          {tab === "memory" ? (
            <EvolutionMemory
              entries={snapshot.playbook}
              busy={busy}
              canReview={review}
              mutate={mutate}
            />
          ) : null}
          {tab === "proposals" ? (
            <EvolutionProposals
              base={base}
              proposals={snapshot.proposals}
              episodes={snapshot.episodes}
              feedback={snapshot.feedback}
              currentRevisionId={currentRevisionId}
              busy={busy}
              canReview={review && execute}
              mutate={mutate}
              format={format}
            />
          ) : null}
          {tab === "evaluations" ? (
            <EvolutionEvaluations
              cases={snapshot.cases}
              proposals={snapshot.proposals}
              evaluations={snapshot.evaluations}
              busy={busy}
              canReview={review}
              canExecute={execute}
              mutate={mutate}
              format={format}
            />
          ) : null}
          {tab === "rollout" ? (
            <EvolutionRollout
              rollout={snapshot.rollout}
              evaluations={snapshot.evaluations}
              proposals={snapshot.proposals}
              currentRevisionId={currentRevisionId}
              busy={busy}
              canExecute={execute && review}
              mutate={mutate}
              format={format}
            />
          ) : null}
          {moreResources.length ? (
            <div className="flex flex-wrap gap-2">
              {moreResources.map((resource) => (
                <Button
                  key={resource}
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={loading || busy}
                  onClick={() => void loadMore(resource)}
                >
                  {t("loadMore", { label: t(RESOURCE_LABELS[resource]) })}
                </Button>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
