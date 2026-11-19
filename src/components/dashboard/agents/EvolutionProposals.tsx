"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/motion/button";
import { FormCheckbox } from "@/components/ui/FormCheckbox";
import { RevisionFileDiff } from "../RevisionFileDiff";
import {
  buildAgentRevisionDiff,
  type RevisionDiffFile,
} from "@/lib/revisions/config-diff";
import type {
  EpisodeDto,
  FeedbackDto,
  ProposalDetailDto,
  ProposalDto,
} from "@/lib/agents/evolution/contracts";
import { evolutionRequest } from "./evolution-client";
import {
  Empty,
  Failure,
  Notice,
  RecordCard,
  type EvolutionFormat,
  type Mutation,
} from "./evolution-ui";

export function EvolutionProposals({
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
