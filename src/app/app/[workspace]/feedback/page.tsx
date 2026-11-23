import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getCurrentUser } from "@/lib/auth/current-user";
import { resolveWorkspaceScope } from "@/lib/workspace/scope";
import { DashboardHeader } from "@/components/dashboard/DashboardHeader";
import { DashboardPage } from "@/components/dashboard/DashboardUI";
import { FeedbackClient } from "@/components/dashboard/FeedbackClient";
import {
  FEEDBACK_CATEGORIES,
  type FeedbackCategory,
} from "@/lib/feedback/types";

export const dynamic = "force-dynamic";

function normalizeCategory(value: string | undefined): FeedbackCategory {
  if (value && (FEEDBACK_CATEGORIES as readonly string[]).includes(value)) {
    return value as FeedbackCategory;
  }
  return "bug";
}

function cleanParam(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export default async function WorkspaceFeedbackPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{
    category?: string;
    failureCode?: string;
    workSessionId?: string;
    taskId?: string;
    conversationId?: string;
    agentId?: string;
  }>;
}) {
  const [{ workspace }, query, user, t] = await Promise.all([
    params,
    searchParams,
    getCurrentUser(),
    getTranslations("console.feedback"),
  ]);

  const baseHref = `/app/${encodeURIComponent(workspace)}/feedback`;
  if (!user) {
    redirect(`/app/login?next=${encodeURIComponent(baseHref)}`);
  }

  const ws = await resolveWorkspaceScope({ slug: workspace }, user.id);
  if (!ws) redirect("/app");

  return (
    <>
      <DashboardHeader title={t("title")} />
      <DashboardPage className="max-w-4xl py-8">
        <FeedbackClient
          workspaceId={ws.id}
          workspaceSlug={ws.slug}
          initialPrefill={{
            category: normalizeCategory(query.category),
            failureCode: cleanParam(query.failureCode),
            workSessionId: cleanParam(query.workSessionId),
            taskId: cleanParam(query.taskId),
            conversationId: cleanParam(query.conversationId),
            agentId: cleanParam(query.agentId),
          }}
        />
      </DashboardPage>
    </>
  );
}
