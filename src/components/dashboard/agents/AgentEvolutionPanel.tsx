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
  "w-full min-w-0 rounded-lg border border-border bg-background p-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

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

function mergeRecords<T extends { id: string }>(latest: T[], previous: T[]) {
  const ids = new Set(latest.map((item) => item.id));
  return [...latest, ...previous.filter((item) => !ids.has(item.id))];
}

function Field({
  label,
  children,
}: {
  label: string;
  children: ReactElement<{ id?: string }>;
}) {
  const id = useId();
  return (
    <label
      htmlFor={id}
      className="flex min-w-0 flex-col gap-1.5 text-sm font-medium"
    >
      {label}
      {cloneElement(children, { id })}
    </label>
  );
}
function Empty({ count }: { count: number }) {
  const t = useTranslations("console.evolution");
  return count ? null : (
    <p className="py-3 text-sm text-muted-foreground">{t("empty")}</p>
  );
}
function RecordCard({
  title,
  children,
}: {
  title: ReactNode;
  children: ReactNode;
}) {
  return (
    <article className="min-w-0 space-y-3 rounded-xl border border-border p-4">
      <h4 className="break-words font-medium">{title}</h4>
      {children}
    </article>
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
  const locale = useLocale();
  const router = useRouter();
  const base = `/api/v1/agents/${encodeURIComponent(agentId)}/evolution`;
  const [snapshot, setSnapshot] = useState<EvolutionSnapshot | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState("settings");
  const [proposal, setProposal] = useState<ProposalDetailDto | null>(null);
  const [proposalBusy, setProposalBusy] = useState(false);
  const [cursors, setCursors] = useState<
    Partial<Record<ListResource, string | null>>
  >({});
  const dates = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        dateStyle: "medium",
        timeStyle: "short",
      }),
    [locale],
  );
  const date = (value: string) => dates.format(new Date(value));
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
      setError(cause instanceof Error ? cause.message : "EVOLUTION_FAILED");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    load(controller.signal)
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : "EVOLUTION_FAILED");
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
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : "EVOLUTION_FAILED");
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
      setError(cause instanceof Error ? cause.message : "EVOLUTION_FAILED");
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
      setProposal(null);
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
  async function openProposal(id: string) {
    setProposalBusy(true);
    setProposal(null);
    setError("");
    try {
      setProposal(
        await evolutionRequest<ProposalDetailDto>(
          `${base}/proposals?id=${encodeURIComponent(id)}`,
        ),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "EVOLUTION_FAILED");
    } finally {
      setProposalBusy(false);
    }
  }
  const review = snapshot?.overview.permissions.canReview ?? false;
  const execute = snapshot?.overview.permissions.canExecute ?? false;
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
      <nav aria-label={t("navigation")} className="flex flex-wrap gap-1">
        {[
          "settings",
          "experience",
          "memory",
          "proposals",
          "evaluations",
          "rollout",
        ].map((item) => (
          <Button
            key={item}
            type="button"
            size="sm"
            variant={tab === item ? "primary" : "ghost"}
            aria-current={tab === item ? "page" : undefined}
            onClick={() => setTab(item)}
          >
            {t(`tabs.${item}`)}
          </Button>
        ))}
      </nav>
      {error ? (
        <p role="alert" className="break-words text-sm text-destructive">
          {errorText(error)}
        </p>
      ) : null}
      {loading && !snapshot ? <p role="status">{t("loading")}</p> : null}
      {snapshot ? (
        <>
          {!review ? (
            <p className="text-sm text-muted-foreground">{t("readOnly")}</p>
          ) : null}
          {tab === "settings" ? (
            <>
              <EvolutionSettings
                key={agentId}
                overview={snapshot.overview}
                busy={busy}
                mutate={mutate}
              />
              <section className="space-y-3">
                <h4 className="font-medium">{t("reflections")}</h4>
                <Button
                  type="button"
                  disabled={
                    !execute || busy || !snapshot.overview.settings.enabled
                  }
                  onClick={() => void mutate("reflections", "POST", {})}
                >
                  {t("reflect")}
                </Button>
                <p className="text-xs text-muted-foreground">
                  {t("reflectionHelp")}
                </p>
                <Empty count={snapshot.reflections.length} />
                {snapshot.reflections.map((item) => (
                  <RecordCard
                    key={item.id}
                    title={`${t(`status.${item.status}`)} · ${date(item.createdAt)}`}
                  >
                    <p className="text-xs">
                      {t("cost", { value: item.costMicros })}
                    </p>
                    {item.failureCode ? (
                      <p
                        role="alert"
                        className="break-all text-sm text-destructive"
                      >
                        {item.failureCode}
                      </p>
                    ) : null}
                  </RecordCard>
                ))}
              </section>
            </>
          ) : null}
          {tab === "experience" ? (
            <div className="space-y-5">
              <section className="space-y-3">
                <h4 className="font-medium">{t("episodes")}</h4>
                <Empty count={snapshot.episodes.length} />
                {snapshot.episodes.map((item) => (
                  <RecordCard
                    key={item.id}
                    title={`${t(`status.${item.outcome}`)} · ${date(item.createdAt)}`}
                  >
                    <p className="whitespace-pre-wrap break-words text-sm">
                      {item.summary}
                    </p>
                    <p className="break-all text-xs text-muted-foreground">
                      {t("source")}: {item.taskId ?? item.conversationId} ·{" "}
                      {t("revision")}: {item.revisionId}
                    </p>
                    <p className="text-xs">
                      {t("tokens", {
                        input: item.inputTokens,
                        output: item.outputTokens,
                      })}{" "}
                      · {t("cost", { value: item.costMicros })}
                    </p>
                    {item.failureCode ? (
                      <p className="break-all text-xs text-destructive">
                        {item.failureCode}
                      </p>
                    ) : null}
                  </RecordCard>
                ))}
              </section>
              <section className="space-y-3">
                <h4 className="font-medium">{t("feedback")}</h4>
                <Empty count={snapshot.feedback.length} />
                {snapshot.feedback.map((item) => (
                  <RecordCard
                    key={item.id}
                    title={`${t(item.rating)} · ${date(item.createdAt)}`}
                  >
                    <p className="whitespace-pre-wrap break-words text-sm">
                      {item.comment}
                    </p>
                    <p className="break-all text-xs text-muted-foreground">
                      {t("source")}: {item.conversationId} / {item.messageId} ·{" "}
                      {t("author")}: {item.createdById}
                    </p>
                  </RecordCard>
                ))}
              </section>
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
            <section className="space-y-4">
              <p className="text-sm text-muted-foreground">
                {t("proposalHelp")}
              </p>
              <Empty count={snapshot.proposals.length} />
              {snapshot.proposals.map((item) => (
                <RecordCard key={item.id} title={item.title}>
                  <p className="text-xs text-muted-foreground">
                    {t(`status.${item.status}`)} · {t(`kind.${item.kind}`)} ·{" "}
                    {date(item.createdAt)}
                  </p>
                  <p className="whitespace-pre-wrap break-words text-sm">
                    {item.rationale}
                  </p>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={proposalBusy || busy}
                    onClick={() => void openProposal(item.id)}
                  >
                    {t("reviewProposal")}
                  </Button>
                </RecordCard>
              ))}
              {proposalBusy ? <p role="status">{t("loading")}</p> : null}
              {proposal ? (
                <EvolutionProposal
                  key={proposal.id}
                  proposal={proposal}
                  busy={busy}
                  canReview={review && execute}
                  mutate={mutate}
                  episodes={snapshot.episodes}
                  feedback={snapshot.feedback}
                />
              ) : null}
            </section>
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
            />
          ) : null}
          <div className="flex flex-wrap gap-2">
            {(Object.keys(cursors) as ListResource[])
              .filter(
                (resource) =>
                  cursors[resource] &&
                  (tab === "settings"
                    ? resource === "reflections"
                    : tab === "experience"
                      ? resource === "episodes" || resource === "feedback"
                      : tab === "memory"
                        ? resource === "playbook"
                        : tab === "proposals"
                          ? resource === "proposals"
                          : tab === "evaluations"
                            ? resource === "cases" ||
                              resource === "evaluations" ||
                              resource === "proposals"
                            : tab === "rollout"
                              ? resource === "evaluations" ||
                                resource === "proposals"
                              : false),
              )
              .map((resource) => (
                <Button
                  key={resource}
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={loading || busy}
                  onClick={() => void loadMore(resource)}
                >
                  {t("loadMore")} ·{" "}
                  {t(
                    resource === "playbook"
                      ? "tabs.memory"
                      : resource === "proposals"
                        ? "tabs.proposals"
                        : resource === "evaluations"
                          ? "results"
                          : resource,
                  )}
                </Button>
              ))}
          </div>
          {tab === "rollout" ? (
            <EvolutionRollout
              rollout={snapshot.rollout}
              evaluations={snapshot.evaluations}
              proposals={snapshot.proposals}
              currentRevisionId={currentRevisionId}
              busy={busy}
              canExecute={execute && review}
              mutate={mutate}
            />
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
}: {
  overview: EvolutionOverviewDto;
  busy: boolean;
  mutate: Mutation;
}) {
  const t = useTranslations("console.evolution");
  const [enabled, setEnabled] = useState(overview.settings.enabled);
  const [automatic, setAutomatic] = useState(
    overview.settings.reflectionEnabled,
  );
  const [interval, setInterval] = useState(
    String(overview.settings.reflectionIntervalHours),
  );
  const [budget, setBudget] = useState(overview.settings.monthlyBudgetMicros);
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        void mutate("settings", "PUT", {
          enabled,
          reflectionEnabled: automatic,
          reflectionIntervalHours: Number(interval),
          monthlyBudgetMicros: budget,
        });
      }}
    >
      <fieldset
        className="min-w-0 space-y-4"
        disabled={busy || !overview.permissions.canReview}
      >
        <FormCheckbox
          checked={enabled}
          onCheckedChange={setEnabled}
          label={t("enabled")}
        />
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
              value={interval}
              onChange={(event) => setInterval(event.target.value)}
            />
          </Field>
          <Field label={t("budget")}>
            <input
              className={inputClass}
              type="text"
              inputMode="numeric"
              required
              pattern="[0-9]+"
              value={budget}
              onChange={(event) => setBudget(event.target.value)}
            />
          </Field>
        </div>
        <Button type="submit" disabled={busy}>
          {t("save")}
        </Button>
      </fieldset>
      <p className="text-xs text-muted-foreground">
        {t("spent", { value: overview.settings.spentMicros })}
      </p>
      {overview.settings.nextReflectionAt ? (
        <p className="break-all text-xs text-muted-foreground">
          {t("nextReflection")}: {overview.settings.nextReflectionAt}
        </p>
      ) : null}
    </form>
  );
}

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
  const mergeEntries = entries.filter((entry) => mergeIds.includes(entry.id));
  const sameScope = mergeEntries.every(
    (entry) =>
      JSON.stringify(entry.scope) === JSON.stringify(mergeEntries[0]?.scope),
  );
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
    if (changed) {
      setContent("");
      setEditing(null);
      setMergeIds([]);
    }
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
    <section className="space-y-4">
      <p className="text-sm text-muted-foreground">{t("memoryHelp")}</p>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <fieldset className="min-w-0 space-y-3" disabled={busy || !canReview}>
          <Field label={t("scope")}>
            <select
              className={inputClass}
              disabled={Boolean(editing)}
              value={kind}
              onChange={(event) =>
                setKind(event.target.value as EvolutionScope["kind"])
              }
            >
              {["agent", "conversation", "task"].map((value) => (
                <option key={value} value={value}>
                  {t(`scopes.${value}`)}
                </option>
              ))}
            </select>
          </Field>
          {kind !== "agent" ? (
            <Field label={t("scopeId")}>
              <input
                className={inputClass}
                required
                disabled={Boolean(editing)}
                value={scopeId}
                onChange={(event) => setScopeId(event.target.value)}
              />
            </Field>
          ) : null}
          <Field label={t("memoryContent")}>
            <textarea
              className={inputClass}
              required
              rows={4}
              maxLength={20000}
              value={content}
              onChange={(event) => setContent(event.target.value)}
            />
          </Field>
          {editing ? (
            <p className="text-xs text-muted-foreground">
              {t("memoryEditHelp")}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit">
              {editing ? t("save") : t("submitMemory")}
            </Button>
            {editing ? (
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setEditing(null);
                  setContent("");
                  setMergeIds([]);
                }}
              >
                {t("cancel")}
              </Button>
            ) : null}
          </div>
        </fieldset>
      </form>
      <p className="text-xs text-muted-foreground">{t("mergeHelp")}</p>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={busy || !canReview || mergeEntries.length < 2 || !sameScope}
        onClick={() => {
          const first = mergeEntries[0];
          if (!first) return;
          edit(first);
          setContent(first.content);
        }}
      >
        {t("mergeMemory")}
      </Button>
      <Empty count={entries.length} />
      {entries.map((item) => (
        <RecordCard
          key={item.id}
          title={`${t(`scopes.${item.scope.kind}`)} · ${t(`status.${item.status}`)} · v${item.version}`}
        >
          <p className="whitespace-pre-wrap break-words text-sm">
            {item.content}
          </p>
          {item.scope.kind !== "agent" ? (
            <p className="break-all text-xs text-muted-foreground">
              {item.scope.kind === "conversation"
                ? item.scope.conversationId
                : item.scope.taskId}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            {item.status !== "archived" ? (
              <>
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
              </>
            ) : null}
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
            {item.status !== "archived" ? (
              <Button
                type="button"
                variant="secondary"
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
            ) : null}
          </div>
        </RecordCard>
      ))}
    </section>
  );
}

function EvolutionProposal({
  proposal,
  episodes,
  feedback,
  busy,
  canReview,
  mutate,
}: {
  proposal: ProposalDetailDto;
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
  return (
    <RecordCard title={proposal.title}>
      <p className="whitespace-pre-wrap break-words text-sm">
        {proposal.rationale}
      </p>
      <p className="break-all text-xs text-muted-foreground">
        {t("baseline")}: {proposal.baseRevisionId}
      </p>
      {proposal.newSkill && !proposal.candidateRevisionId ? (
        <p className="text-sm text-muted-foreground">
          {t("newSkillConsent", { name: proposal.newSkill.name })}
        </p>
      ) : null}
      <section className="space-y-2">
        <h5 className="text-sm font-medium">{t("evidence")}</h5>
        {proposal.evidence &&
        (proposal.evidence.episodeIds.length ||
          proposal.evidence.feedbackIds.length) ? (
          <ul className="space-y-1 text-xs">
            {proposal.evidence.episodeIds.map((id) => (
              <li key={`episode:${id}`} className="break-all">
                {t("episodes")}: {id}
                <p className="whitespace-pre-wrap break-words">
                  {episodes.find((episode) => episode.id === id)?.summary}
                </p>
              </li>
            ))}
            {proposal.evidence.feedbackIds.map((id) => (
              <li key={`feedback:${id}`} className="break-all">
                {t("feedback")}: {id}
                <p className="whitespace-pre-wrap break-words">
                  {feedback.find((entry) => entry.id === id)?.comment}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">
            {t("evidenceMissing")}
          </p>
        )}
      </section>
      <RevisionFileDiff diff={diff} />
      {proposal.status === "pending" ? (
        <>
          <FormCheckbox
            disabled={busy || !canReview}
            checked={consent}
            onCheckedChange={setConsent}
            label={t("proposalConsent")}
          />
          <div className="flex flex-wrap gap-2">
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
        </>
      ) : null}
    </RecordCard>
  );
}

function EvolutionEvaluations({
  cases,
  proposals,
  evaluations,
  busy,
  canReview,
  canExecute,
  mutate,
}: {
  cases: EvolutionCaseDto[];
  proposals: ProposalDto[];
  evaluations: EvaluationDto[];
  busy: boolean;
  canReview: boolean;
  canExecute: boolean;
  mutate: Mutation;
}) {
  const t = useTranslations("console.evolution");
  const [editing, setEditing] = useState<EvolutionCaseDto | null>(null);
  const [name, setName] = useState("");
  const [input, setInput] = useState("");
  const [expected, setExpected] = useState("");
  const [criterion, setCriterion] =
    useState<NonNullable<EvolutionCaseDto["criterion"]>>("exact");
  const [proposalId, setProposalId] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [recordedTools, setRecordedTools] = useState("[]");
  const [requiredTools, setRequiredTools] = useState("");
  function resetCase() {
    setEditing(null);
    setName("");
    setInput("");
    setExpected("");
    setCriterion("exact");
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
    <div className="space-y-6">
      <section className="space-y-3">
        <h4 className="font-medium">{t("cases")}</h4>
        <p className="text-sm text-muted-foreground">{t("casesHelp")}</p>
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
                  setCriterion(
                    event.target.value as NonNullable<
                      EvolutionCaseDto["criterion"]
                    >,
                  )
                }
              >
                {["exact", "contains", "rubric"].map((value) => (
                  <option key={value} value={value}>
                    {t(`criteria.${value}`)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t("caseExpected")}>
              <textarea
                className={inputClass}
                required
                rows={3}
                value={expected}
                onChange={(event) => setExpected(event.target.value)}
              />
            </Field>
            <Field label={t("requiredTools")}>
              <textarea
                className={inputClass}
                rows={2}
                value={requiredTools}
                onChange={(event) => setRequiredTools(event.target.value)}
              />
            </Field>
            <Field label={t("recordedTools")}>
              <textarea
                className={`${inputClass} font-mono`}
                rows={6}
                value={recordedTools}
                onChange={(event) => setRecordedTools(event.target.value)}
                spellCheck={false}
              />
            </Field>
            <p className="text-xs text-muted-foreground">
              {t("recordedToolsHelp")}
            </p>
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
        <Empty count={cases.length} />
        {cases.map((item) => (
          <RecordCard key={item.id} title={item.name}>
            <p className="whitespace-pre-wrap break-words text-sm">
              {item.input}
            </p>
            <p className="text-xs text-muted-foreground">
              {t(`criteria.${item.criterion ?? "exact"}`)}
            </p>
            <details>
              <summary className="cursor-pointer text-sm">
                {t("caseExpected")}
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
            {item.recordedTools?.length ? (
              <details>
                <summary className="cursor-pointer text-sm">
                  {t("recordedTools")}
                </summary>
                <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words text-xs">
                  {JSON.stringify(item.recordedTools, null, 2)}
                </pre>
              </details>
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
            ) : null}
          </RecordCard>
        ))}
      </section>
      <section className="space-y-3">
        <h4 className="font-medium">{t("runEvaluation")}</h4>
        <p className="text-sm text-muted-foreground">{t("evaluationHelp")}</p>
        <Field label={t("candidate")}>
          <select
            className={inputClass}
            value={proposalId}
            onChange={(event) => setProposalId(event.target.value)}
          >
            <option value="">{t("chooseCandidate")}</option>
            {proposals
              .filter(
                (item) =>
                  item.status === "approved" && item.candidateRevisionId,
              )
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title}
                </option>
              ))}
          </select>
        </Field>
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
      </section>
      <section className="space-y-3">
        <h4 className="font-medium">{t("results")}</h4>
        <Empty count={evaluations.length} />
        {evaluations.map((evaluation) => (
          <RecordCard
            key={evaluation.id}
            title={`${proposals.find((item) => item.id === evaluation.proposalId)?.title ?? evaluation.proposalId} · ${t(`status.${evaluation.status}`)}`}
          >
            <p className="break-all text-xs">
              {t("baseline")}: {evaluation.baselineRevisionId}
              <br />
              {t("candidate")}: {evaluation.candidateRevisionId}
            </p>
            {evaluation.pareto ? (
              <p className="text-sm font-medium">
                {t(`pareto.${evaluation.pareto}`)}
              </p>
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
                  .join(", ")}
              </p>
            ) : null}
            {evaluation.failureCode ? (
              <p className="text-sm text-destructive">
                {evaluation.failureCode}
              </p>
            ) : null}
            <div className="max-w-full overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr>
                    {[
                      "caseName",
                      "variant",
                      "quality",
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
                      <td className="p-2 tabular-nums">{result.quality}</td>
                      <td className="p-2 tabular-nums">
                        {result.costMicros}
                        {result.judgeCostMicros ? (
                          <p>
                            {t("judgeCost", { value: result.judgeCostMicros })}
                          </p>
                        ) : null}
                      </td>
                      <td className="min-w-40 max-w-80 p-2">
                        <details>
                          <summary className="cursor-pointer">
                            {result.failureCode ?? t("viewOutput")}
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
          </RecordCard>
        ))}
      </section>
    </div>
  );
}

function EvolutionRollout({
  rollout,
  evaluations,
  proposals,
  currentRevisionId,
  busy,
  canExecute,
  mutate,
}: {
  rollout: RolloutDto | null;
  evaluations: EvaluationDto[];
  proposals: ProposalDto[];
  currentRevisionId: string | null;
  busy: boolean;
  canExecute: boolean;
  mutate: Mutation;
}) {
  const t = useTranslations("console.evolution");
  const [evaluationId, setEvaluationId] = useState("");
  const [percentage, setPercentage] = useState("10");
  const [confirm, setConfirm] = useState<
    "stop" | "promote" | "rollback" | null
  >(null);
  const [isolationRisk, setIsolationRisk] = useState(false);
  const evaluation = evaluations.find((item) => item.id === evaluationId);
  return (
    <section className="space-y-4">
      <p className="text-sm text-muted-foreground">{t("rolloutHelp")}</p>
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
          disabled={busy || !canExecute || rollout?.status === "active"}
        >
          <Field label={t("successfulEvaluation")}>
            <select
              className={inputClass}
              required
              value={evaluationId}
              onChange={(event) => setEvaluationId(event.target.value)}
            >
              <option value="">{t("chooseEvaluation")}</option>
              {evaluations
                .filter((item) => item.status === "succeeded")
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {proposals.find(
                      (proposal) => proposal.id === item.proposalId,
                    )?.title ?? item.proposalId}{" "}
                    · {item.pareto ? t(`pareto.${item.pareto}`) : item.id}
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
      {rollout ? (
        <RecordCard
          title={`${t(`status.${rollout.status}`)} · ${rollout.percentage}%`}
        >
          <p className="break-all text-xs">
            {t("baseline")}: {rollout.baselineRevisionId}
            <br />
            {t("candidate")}: {rollout.candidateRevisionId}
          </p>
          {rollout.metrics ? (
            <>
              <p className="text-sm font-medium">
                {t(`sample.${rollout.metrics.sampleStatus}`)} ·{" "}
                {t(`recommendation.${rollout.metrics.recommendation}`)}
              </p>
              <div className="max-w-full overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr>
                      <th scope="col" className="p-2">
                        {t("metric")}
                      </th>
                      <th scope="col" className="p-2">
                        {t("baseline")}
                      </th>
                      <th scope="col" className="p-2">
                        {t("candidate")}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {(
                      [
                        "tasks",
                        "succeeded",
                        "failed",
                        "toolCalls",
                        "toolFailures",
                        "averageCostMicros",
                        "feedbackPositive",
                        "feedbackNegative",
                        "successRate",
                      ] as const
                    ).map((metric) => (
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
            {(rollout.status === "active"
              ? (["stop", "promote", "rollback"] as const)
              : rollout.status === "promoted" || rollout.status === "stopped"
                ? (["rollback"] as const)
                : []
            ).map((action) => (
              <Button
                key={action}
                type="button"
                variant="secondary"
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
          ) : null}
        </RecordCard>
      ) : (
        <Empty count={0} />
      )}
    </section>
  );
}
