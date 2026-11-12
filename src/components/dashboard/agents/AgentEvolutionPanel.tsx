"use client";

import {
  cloneElement,
  useId,
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/motion/button";
import { FormCheckbox } from "@/components/ui/FormCheckbox";
import { RevisionFileDiff } from "../RevisionFileDiff";
import { notify } from "../Toaster";
import {
  buildAgentRevisionDiff,
  type RevisionDiffFile,
} from "@/lib/revisions/config-diff";
import type {
  EpisodeDto,
  EvaluationDto,
  EvolutionCaseDto,
  EvolutionOverviewDto,
  EvolutionScope,
  FeedbackDto,
  PlaybookDto,
  ProposalDetailDto,
  ProposalDto,
  ReflectionDto,
  RolloutDto,
} from "@/lib/agents/evolution/contracts";
import { evolutionRequest } from "./evolution-client";

const inputClass =
  "w-full min-w-0 rounded-lg border border-border bg-background p-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60";

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
type Mutation = (
  path: string,
  method: string,
  body?: unknown,
) => Promise<boolean>;
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

interface EvolutionFormat {
  date(value: string): string;
  money(micros: string | number): string;
  score(value: number): string;
  version(id: string | null | undefined): string;
  failure(code: string): string;
}
// Reads never change state, so any failure other than an access problem gets the
// plain "could not load" message, not the warning reserved for mutations.
const LOAD_ERROR_CODES: Record<string, true> = {
  UNAUTHORIZED: true,
  NOT_FOUND: true,
  FORBIDDEN: true,
};
function loadFailure(cause: unknown) {
  return cause instanceof Error &&
    Object.hasOwn(LOAD_ERROR_CODES, cause.message)
    ? cause.message
    : "LOAD_FAILED";
}

/** Costs are stored in micro-USD; versions are shown by number, never by internal ID. */
function useEvolutionFormat(
  revisions: EvolutionOverviewDto["revisions"],
): EvolutionFormat {
  const t = useTranslations("console.evolution");
  const locale = useLocale();
  return useMemo<EvolutionFormat>(() => {
    const dates = new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
    });
    const currency = new Intl.NumberFormat(locale, {
      style: "currency",
      currency: "USD",
      currencyDisplay: "narrowSymbol",
      minimumFractionDigits: 2,
      maximumFractionDigits: 6,
    });
    const percent = new Intl.NumberFormat(locale, {
      style: "percent",
      maximumFractionDigits: 0,
    });
    const versions = new Map(revisions.map((item) => [item.id, item.version]));
    return {
      date: (value: string) => dates.format(new Date(value)),
      money: (micros: string | number) =>
        currency.format(Number(micros) / 1_000_000),
      score: (value: number) => percent.format(value),
      version: (id: string | null | undefined) => {
        const version = id ? versions.get(id) : undefined;
        return version === undefined ? t("unknownVersion") : `v${version}`;
      },
      failure: (code: string) =>
        t.has(`failures.${code}`)
          ? t(`failures.${code}`)
          : t("failures.unknown", { code }),
    };
  }, [locale, revisions, t]);
}

function mergeRecords<T extends { id: string }>(latest: T[], previous: T[]) {
  const ids = new Set(latest.map((item) => item.id));
  return [...latest, ...previous.filter((item) => !ids.has(item.id))];
}

function Field({
  label,
  help,
  children,
}: {
  label: string;
  help?: string;
  children: ReactElement<{ id?: string }>;
}) {
  const id = useId();
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {cloneElement(children, { id })}
      {help ? <p className="text-xs text-muted-foreground">{help}</p> : null}
    </div>
  );
}
function Empty({ count }: { count: number }) {
  const t = useTranslations("console.evolution");
  return count ? null : (
    <p className="py-3 text-sm text-muted-foreground">{t("empty")}</p>
  );
}
function Notice({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
      {children}
    </p>
  );
}
function Failure({ text }: { text: string }) {
  return <p className="break-words text-sm text-destructive">{text}</p>;
}
function RecordCard({
  title,
  meta,
  children,
}: {
  title: ReactNode;
  meta?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <article className="min-w-0 space-y-3 rounded-xl border border-border p-4">
      <div className="space-y-1">
        <h5 className="break-words font-medium">{title}</h5>
        {meta ? (
          <p className="break-words text-xs text-muted-foreground">{meta}</p>
        ) : null}
      </div>
      {children}
    </article>
  );
}
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h4 className="font-medium">{title}</h4>
      {children}
    </section>
  );
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
      const code = committed
        ? "REFRESH_FAILED"
        : cause instanceof Error
          ? cause.message
          : "EVOLUTION_FAILED";
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
    <div className="min-w-0 space-y-5 p-4 sm:p-6" aria-busy={busy || loading}>
      <header className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-base font-semibold">{t("title")}</h3>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => void refresh()}
            disabled={busy || loading}
          >
            {t("refresh")}
          </Button>
        </div>
        <p className="text-sm leading-6 text-muted-foreground">
          {t("description")}
        </p>
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

function EvolutionSettings({
  overview,
  busy,
  mutate,
  format,
}: {
  overview: EvolutionOverviewDto;
  busy: boolean;
  mutate: Mutation;
  format: EvolutionFormat;
}) {
  const t = useTranslations("console.evolution");
  const { settings } = overview;
  const [enabled, setEnabled] = useState(settings.enabled);
  const [automatic, setAutomatic] = useState(settings.reflectionEnabled);
  const [interval, setInterval] = useState(
    String(settings.reflectionIntervalHours),
  );
  const [budgetUsd, setBudgetUsd] = useState(
    String(Number(settings.monthlyBudgetMicros) / 1_000_000),
  );
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        void mutate("settings", "PUT", {
          enabled,
          reflectionEnabled: automatic,
          reflectionIntervalHours: Number(interval),
          monthlyBudgetMicros: String(
            Math.round(Number(budgetUsd) * 1_000_000),
          ),
        });
      }}
    >
      <fieldset
        className="min-w-0 space-y-4"
        disabled={busy || !overview.permissions.canReview}
      >
        <div className="space-y-1">
          <FormCheckbox
            checked={enabled}
            onCheckedChange={setEnabled}
            label={t("enabled")}
          />
          <p className="text-xs text-muted-foreground">{t("enabledHelp")}</p>
        </div>
        <FormCheckbox
          checked={automatic}
          onCheckedChange={setAutomatic}
          label={t("automatic")}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("interval")}>
            <input
              className={inputClass}
              type="number"
              required
              min={1}
              max={8760}
              disabled={!automatic}
              value={interval}
              onChange={(event) => setInterval(event.target.value)}
            />
          </Field>
          <Field label={t("budget")} help={t("budgetHelp")}>
            <input
              className={inputClass}
              type="number"
              required
              min={0}
              max={1_000_000}
              step={0.01}
              value={budgetUsd}
              onChange={(event) => setBudgetUsd(event.target.value)}
            />
          </Field>
        </div>
        <Button type="submit" disabled={busy}>
          {t("save")}
        </Button>
      </fieldset>
      <p className="text-sm">
        {t("spent", {
          spent: format.money(settings.spentMicros),
          budget: format.money(settings.monthlyBudgetMicros),
        })}
      </p>
      {settings.enabled && settings.nextReflectionAt ? (
        <p className="text-sm text-muted-foreground">
          {t("nextReflection", {
            time: format.date(settings.nextReflectionAt),
          })}
        </p>
      ) : null}
    </form>
  );
}

const MEMORY_ORDER: Record<PlaybookDto["status"], number> = {
  pending: 0,
  approved: 1,
  rejected: 2,
  archived: 3,
};

function EvolutionMemory({
  entries,
  busy,
  canReview,
  mutate,
}: {
  entries: PlaybookDto[];
  busy: boolean;
  canReview: boolean;
  mutate: Mutation;
}) {
  const t = useTranslations("console.evolution");
  const [content, setContent] = useState("");
  const [kind, setKind] = useState<EvolutionScope["kind"]>("agent");
  const [scopeId, setScopeId] = useState("");
  const [editing, setEditing] = useState<PlaybookDto | null>(null);
  const [mergeIds, setMergeIds] = useState<string[]>([]);
  const sorted = useMemo(
    () =>
      [...entries].sort(
        (a, b) => MEMORY_ORDER[a.status] - MEMORY_ORDER[b.status],
      ),
    [entries],
  );
  const mergeEntries = entries.filter((entry) => mergeIds.includes(entry.id));
  const sameScope = mergeEntries.every(
    (entry) =>
      JSON.stringify(entry.scope) === JSON.stringify(mergeEntries[0]?.scope),
  );
  function reset() {
    setEditing(null);
    setContent("");
    setMergeIds([]);
  }
  async function save() {
    const scope: EvolutionScope =
      kind === "agent"
        ? { kind }
        : kind === "conversation"
          ? { kind, conversationId: scopeId }
          : { kind, taskId: scopeId };
    const changed = editing
      ? await mutate("playbook", "PATCH", {
          id: editing.id,
          expectedVersion: editing.version,
          content,
          ...(mergeIds.length > 1
            ? { mergeIds: mergeIds.filter((id) => id !== editing.id) }
            : {}),
        })
      : await mutate("playbook", "POST", { content, scope });
    if (changed) reset();
  }
  function edit(entry: PlaybookDto) {
    setEditing(entry);
    setContent(entry.content);
    setKind(entry.scope.kind);
    setScopeId(
      entry.scope.kind === "conversation"
        ? entry.scope.conversationId
        : entry.scope.kind === "task"
          ? entry.scope.taskId
          : "",
    );
  }
  return (
    <div className="space-y-6">
      <Section title={editing ? t("editMemory") : t("newMemory")}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <fieldset className="min-w-0 space-y-3" disabled={busy || !canReview}>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t("scope")}>
                <select
                  className={inputClass}
                  disabled={Boolean(editing)}
                  value={kind}
                  onChange={(event) =>
                    setKind(event.target.value as EvolutionScope["kind"])
                  }
                >
                  {(["agent", "conversation", "task"] as const).map((value) => (
                    <option key={value} value={value}>
                      {t(`scopes.${value}`)}
                    </option>
                  ))}
                </select>
              </Field>
              {kind !== "agent" ? (
                <Field
                  label={
                    kind === "conversation" ? t("conversationId") : t("taskId")
                  }
                >
                  <input
                    className={inputClass}
                    required
                    disabled={Boolean(editing)}
                    value={scopeId}
                    onChange={(event) => setScopeId(event.target.value)}
                  />
                </Field>
              ) : null}
            </div>
            <Field
              label={t("memoryContent")}
              help={editing ? t("memoryEditHelp") : undefined}
            >
              <textarea
                className={inputClass}
                required
                rows={4}
                maxLength={20000}
                value={content}
                onChange={(event) => setContent(event.target.value)}
              />
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button type="submit">
                {editing ? t("save") : t("submitMemory")}
              </Button>
              {editing ? (
                <Button type="button" variant="secondary" onClick={reset}>
                  {t("cancel")}
                </Button>
              ) : null}
            </div>
          </fieldset>
        </form>
      </Section>
      <Section title={t("steps.memory")}>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={
              busy || !canReview || mergeEntries.length < 2 || !sameScope
            }
            onClick={() => {
              const first = mergeEntries[0];
              if (first) edit(first);
            }}
          >
            {t("mergeMemory")}
          </Button>
          <p className="text-xs text-muted-foreground">{t("mergeHelp")}</p>
        </div>
        <Empty count={sorted.length} />
        {sorted.map((item) => (
          <RecordCard
            key={item.id}
            title={`${t(`status.${item.status}`)} · ${t(`scopeTags.${item.scope.kind}`)}`}
            meta={
              item.scope.kind === "conversation"
                ? `${t("conversationId")}: ${item.scope.conversationId}`
                : item.scope.kind === "task"
                  ? `${t("taskId")}: ${item.scope.taskId}`
                  : undefined
            }
          >
            <p className="whitespace-pre-wrap break-words text-sm">
              {item.content}
            </p>
            {item.status !== "archived" ? (
              <div className="flex flex-wrap items-center gap-2">
                {item.status === "pending" ? (
                  <>
                    <Button
                      type="button"
                      size="sm"
                      disabled={busy || !canReview}
                      onClick={() =>
                        void mutate("playbook", "PATCH", {
                          id: item.id,
                          status: "approved",
                          expectedVersion: item.version,
                        })
                      }
                    >
                      {t("approveMemory")}
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      disabled={busy || !canReview}
                      onClick={() =>
                        void mutate("playbook", "PATCH", {
                          id: item.id,
                          status: "rejected",
                          expectedVersion: item.version,
                        })
                      }
                    >
                      {t("reject")}
                    </Button>
                  </>
                ) : null}
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={busy || !canReview}
                  onClick={() => {
                    setMergeIds([]);
                    edit(item);
                  }}
                >
                  {t("editMemory")}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy || !canReview}
                  onClick={() =>
                    void mutate("playbook", "PATCH", {
                      id: item.id,
                      status: "archived",
                      expectedVersion: item.version,
                    })
                  }
                >
                  {t("archive")}
                </Button>
                <FormCheckbox
                  disabled={busy || !canReview || Boolean(editing)}
                  checked={mergeIds.includes(item.id)}
                  onCheckedChange={(checked) =>
                    setMergeIds((previous) =>
                      checked
                        ? [...previous, item.id]
                        : previous.filter((id) => id !== item.id),
                    )
                  }
                  label={t("selectMemory")}
                />
              </div>
            ) : null}
          </RecordCard>
        ))}
      </Section>
    </div>
  );
}

function EvolutionProposals({
  base,
  proposals,
  episodes,
  feedback,
  currentRevisionId,
  busy,
  canReview,
  mutate,
  format,
}: {
  base: string;
  proposals: ProposalDto[];
  episodes: EpisodeDto[];
  feedback: FeedbackDto[];
  currentRevisionId: string | null;
  busy: boolean;
  canReview: boolean;
  mutate: Mutation;
  format: EvolutionFormat;
}) {
  const t = useTranslations("console.evolution");
  const [detail, setDetail] = useState<ProposalDetailDto | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState("");
  async function toggle(id: string) {
    if (openId === id) {
      setOpenId(null);
      setDetail(null);
      return;
    }
    setOpenId(id);
    setDetail(null);
    setError("");
    try {
      setDetail(
        await evolutionRequest<ProposalDetailDto>(
          `${base}/proposals?id=${encodeURIComponent(id)}`,
        ),
      );
    } catch {
      setError(t("errors.LOAD_FAILED"));
    }
  }
  return (
    <section className="space-y-4">
      <Empty count={proposals.length} />
      {proposals.map((item) => {
        const stale =
          item.status === "pending" &&
          item.baseRevisionId !== currentRevisionId;
        return (
          <RecordCard
            key={item.id}
            title={item.title}
            meta={[
              t(`status.${item.status}`),
              t(`kind.${item.kind}`),
              t("basedOn", { version: format.version(item.baseRevisionId) }),
              ...(item.candidateRevisionId
                ? [
                    t("candidateVersion", {
                      version: format.version(item.candidateRevisionId),
                    }),
                  ]
                : []),
              format.date(item.createdAt),
            ].join(" · ")}
          >
            <p className="whitespace-pre-wrap break-words text-sm">
              {item.rationale}
            </p>
            {stale ? <Notice>{t("staleProposal")}</Notice> : null}
            <Button
              type="button"
              variant="secondary"
              size="sm"
              aria-expanded={openId === item.id}
              disabled={busy}
              onClick={() => void toggle(item.id)}
            >
              {openId === item.id ? t("hideProposal") : t("reviewProposal")}
            </Button>
            {openId === item.id ? (
              detail?.id === item.id ? (
                <EvolutionProposal
                  key={`${detail.id}:${detail.status}`}
                  proposal={detail}
                  stale={stale}
                  busy={busy}
                  canReview={canReview}
                  mutate={async (...args) => {
                    const changed = await mutate(...args);
                    if (changed) {
                      setOpenId(null);
                      setDetail(null);
                    }
                    return changed;
                  }}
                  episodes={episodes}
                  feedback={feedback}
                />
              ) : error ? (
                <Failure text={error} />
              ) : (
                <p role="status" className="text-sm">
                  {t("loading")}
                </p>
              )
            ) : null}
          </RecordCard>
        );
      })}
    </section>
  );
}

function EvolutionProposal({
  proposal,
  stale,
  episodes,
  feedback,
  busy,
  canReview,
  mutate,
}: {
  proposal: ProposalDetailDto;
  stale: boolean;
  episodes: EpisodeDto[];
  feedback: FeedbackDto[];
  busy: boolean;
  canReview: boolean;
  mutate: Mutation;
}) {
  const t = useTranslations("console.evolution");
  const [consent, setConsent] = useState(false);
  const diff = useMemo(() => {
    const result = buildAgentRevisionDiff(proposal.before, proposal.after);
    if (!proposal.newSkill || proposal.candidateRevisionId) return result;
    const skill = proposal.newSkill;
    const root = `new-skills/${encodeURIComponent(skill.name)}`;
    const documents: Array<{
      path: string;
      language: "text" | "json";
      content: string;
      binary?: boolean;
    }> = [
      { path: `${root}/SKILL.md`, language: "text", content: skill.markdown },
      {
        path: `${root}/metadata.json`,
        language: "json",
        content: `${JSON.stringify({ name: skill.name, description: skill.description }, null, 2)}\n`,
      },
      ...skill.files.map((file) => ({
        path: `${root}/files/${file.path.split("/").map(encodeURIComponent).join("/")}`,
        binary: file.encoding === "base64",
        language:
          file.encoding === "base64" ? ("json" as const) : ("text" as const),
        content:
          file.encoding === "base64"
            ? `${JSON.stringify({ encoding: "base64", content: file.content }, null, 2)}\n`
            : file.content,
      })),
    ];
    const files: RevisionDiffFile[] = documents.map((document) => {
      const content = document.content ? document.content.split("\n") : [];
      if (content.at(-1) === "") content.pop();
      const lines = content.map((line, index) => ({
        id: String(index),
        type: "added" as const,
        newLine: index + 1,
        content: line,
      }));
      const patch = [
        `--- /dev/null`,
        `+++ b/${document.path}`,
        `@@ -0,0 +${lines.length ? 1 : 0},${lines.length} @@`,
        ...content.map((line) => `+${line}`),
      ];
      if (document.content && !document.content.endsWith("\n"))
        patch.push("\\ No newline at end of file");
      return {
        path: document.path,
        language: document.language,
        binary: document.binary,
        lines,
        additions: lines.length,
        deletions: 0,
        patch: `${patch.join("\n")}\n`,
      };
    });
    return {
      files: [...result.files, ...files],
      additions:
        result.additions + files.reduce((sum, file) => sum + file.additions, 0),
      deletions: result.deletions,
    };
  }, [proposal]);
  const evidence = [
    ...(proposal.evidence?.episodeIds ?? []).flatMap((id) => {
      const summary = episodes.find((episode) => episode.id === id)?.summary;
      return summary ? [{ id, label: t("episodes"), text: summary }] : [];
    }),
    ...(proposal.evidence?.feedbackIds ?? []).flatMap((id) => {
      const entry = feedback.find((item) => item.id === id);
      return entry
        ? [
            {
              id,
              label: t(entry.rating),
              text: entry.comment || t("noComment"),
            },
          ]
        : [];
    }),
  ];
  return (
    <div className="space-y-4 border-t border-border pt-4">
      {proposal.newSkill && !proposal.candidateRevisionId ? (
        <p className="text-sm text-muted-foreground">
          {t("newSkillConsent", { name: proposal.newSkill.name })}
        </p>
      ) : null}
      <RevisionFileDiff diff={diff} />
      <details>
        <summary className="cursor-pointer text-sm font-medium">
          {t("evidence")} ({evidence.length})
        </summary>
        {evidence.length ? (
          <ul className="mt-2 space-y-2 text-xs">
            {evidence.map((item) => (
              <li key={item.id} className="rounded-lg bg-muted p-2">
                <span className="font-medium">{item.label}</span>
                <p className="line-clamp-4 whitespace-pre-wrap break-words">
                  {item.text}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-xs text-muted-foreground">
            {t("evidenceMissing")}
          </p>
        )}
      </details>
      {proposal.status === "pending" ? (
        <div className="space-y-3">
          {!stale ? (
            <FormCheckbox
              disabled={busy || !canReview}
              checked={consent}
              onCheckedChange={setConsent}
              label={t("proposalConsent")}
            />
          ) : null}
          <div className="flex flex-wrap gap-2">
            {!stale ? (
              <Button
                type="button"
                disabled={!canReview || busy || !consent || !diff.files.length}
                onClick={() =>
                  void mutate("proposals", "PATCH", {
                    id: proposal.id,
                    decision: "approve",
                    expectedBaseRevisionId: proposal.baseRevisionId,
                  })
                }
              >
                {t("publishCandidate")}
              </Button>
            ) : null}
            <Button
              type="button"
              variant="secondary"
              disabled={!canReview || busy}
              onClick={() =>
                void mutate("proposals", "PATCH", {
                  id: proposal.id,
                  decision: "reject",
                  expectedBaseRevisionId: proposal.baseRevisionId,
                })
              }
            >
              {t("reject")}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

type Criterion = NonNullable<EvolutionCaseDto["criterion"]>;

function EvolutionEvaluations({
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

function EvolutionRollout({
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
