import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getCurrentUser } from "@/lib/auth/current-user";
import { resolveWorkspaceScope } from "@/lib/workspace/scope";
import { DashboardHeader } from "@/components/dashboard/DashboardHeader";
import { DashboardPage } from "@/components/dashboard/DashboardUI";
import { FeedbackClient } from "@/components/dashboard/FeedbackClient";
import { collectFeedbackDiagnosticContext } from "@/lib/feedback/service";
import {
  FEEDBACK_CATEGORIES,
  type FeedbackCategory,
  type FeedbackDiagnosticContext,
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
    captured?: string;
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

  const failureCode = cleanParam(query.failureCode);
  const workSessionId = cleanParam(query.workSessionId);
  const taskId = cleanParam(query.taskId);
  const conversationId = cleanParam(query.conversationId);
  const agentId = cleanParam(query.agentId);

  let initialDiagnostics: FeedbackDiagnosticContext | null = null;
  if (workSessionId || conversationId || taskId || agentId || failureCode) {
    initialDiagnostics = await collectFeedbackDiagnosticContext(user.id, {
      workspaceId: ws.id,
      agentId,
      conversationId,
      taskId,
      workSessionId,
      failureCode,
    }).catch(() => null);
  }

  return (
    <DashboardPage className="max-w-4xl py-8">
      <DashboardHeader title={t("title")} visible />
      <FeedbackClient
        workspaceId={ws.id}
        workspaceSlug={ws.slug}
        captured={query.captured === "1"}
        initialDiagnostics={initialDiagnostics}
        initialPrefill={{
          category: normalizeCategory(query.category),
          failureCode:
            failureCode ?? initialDiagnostics?.failureCode ?? undefined,
          workSessionId:
            workSessionId ?? initialDiagnostics?.workSessionId ?? undefined,
          taskId: taskId ?? initialDiagnostics?.taskId ?? undefined,
          conversationId:
            conversationId ?? initialDiagnostics?.conversationId ?? undefined,
          agentId: agentId ?? initialDiagnostics?.agentId ?? undefined,
        }}
      />
    </DashboardPage>
  );
}
