import { resolveWorkspaceScope } from "@/lib/workspace/scope";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ArrowLeft, ChevronRight, Wrench } from "lucide-react";
import { getCurrentUser } from "@/lib/auth/current-user";
import { db } from "@/lib/db";
import { listMcpTools } from "@/lib/process/mcp-client";
import {
  hasMcpToolCatalog,
  readMcpToolCatalog,
} from "@/lib/process/mcp-tool-catalog";
import { effectiveStatus } from "@/lib/process/supervisor";

import { DashboardPage } from "@/components/dashboard/DashboardUI";
import { McpToolCatalog } from "@/components/dashboard/McpToolCatalog";
import { ToolPlayground } from "@/components/dashboard/ToolPlayground";

export const dynamic = "force-dynamic";

export default async function DeploymentToolPage({
  params,
}: {
  params: Promise<{
    workspace: string;
    deploymentId: string;
    toolName: string;
  }>;
}) {
  const [{ workspace: slug, deploymentId, toolName }, t] = await Promise.all([
    params,
    getTranslations("console.mcp"),
  ]);
  const user = await getCurrentUser();
  const requestedPath = `/app/${slug}/mcp/${deploymentId}/tools/${toolName}`;
  if (!user) redirect(`/app/login?next=${encodeURIComponent(requestedPath)}`);
  const workspace = await resolveWorkspaceScope({ slug }, user.id);
  if (!workspace) redirect("/app");

  const deployment = await db.deployment.findFirst({
    where: {
      id: deploymentId,
      workspaceId: workspace.id,
      OR: [{ source: null }, { source: { not: "sandbox" } }],
    },
    select: {
      id: true,
      name: true,
      source: true,
      sourceRef: true,
      installCfg: true,
      status: true,
      serverId: true,
      server: { select: { name: true, slug: true, installCfg: true } },
    },
  });
  if (!deployment) notFound();

  const base = `/app/${encodeURIComponent(slug)}/mcp/${encodeURIComponent(deployment.id)}`;

  const status = effectiveStatus(deployment.id, deployment.status);
  const running = status === "running";
  const savedTools = hasMcpToolCatalog(deployment.installCfg)
    ? readMcpToolCatalog(deployment.installCfg)
    : readMcpToolCatalog(deployment.server?.installCfg);
  let discoveryFailed = false;
  const liveTools = running
    ? await listMcpTools(deployment.id).catch(() => {
        discoveryFailed = true;
        return [];
      })
    : [];
  const refreshedConfig =
    running && liveTools.length === 0
      ? await db.deployment.findFirst({
          where: { id: deployment.id, workspaceId: workspace.id },
          select: { installCfg: true },
        })
      : null;
  const tools = running
    ? liveTools.length
      ? liveTools
      : hasMcpToolCatalog(refreshedConfig?.installCfg)
        ? readMcpToolCatalog(refreshedConfig?.installCfg)
        : savedTools
    : savedTools;
  const tool = tools.find((candidate) => candidate.name === toolName);
  if (!tool && discoveryFailed) {
    return (
      <DashboardPage>
        <Link href={`${base}?tab=tools`}>{t("tools")}</Link>
        <p role="alert">{t("toolDiscoveryFailed")}</p>
      </DashboardPage>
    );
  }
  if (!tool) notFound();

  const labels = {
    title: t("toolCatalog"),
    description: t("toolCatalogDescription"),
    count: t("toolsCount", { count: 1 }),
    instructions: t("instructions"),
    inputSchema: t("inputSchema"),
    schemaJson: t("schemaJson"),
    parameter: t("parameter"),
    type: t("type"),
    descriptionColumn: t("descriptionColumn"),
    required: t("required"),
    defaultValue: t("defaultValue"),
    noDescription: t("noDescription"),
    noArguments: t("noArguments"),
  };

  return (
    <DashboardPage className="max-w-4xl space-y-6">
      <header className="space-y-3">
        <Link
          href={`${base}?tab=tools`}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" aria-hidden="true" />
          {t("tools")}
        </Link>
        <div className="flex min-w-0 items-start gap-3.5">
          <span className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-xl border border-border bg-card text-muted-foreground">
            <Wrench className="size-5" />
          </span>
          <div className="min-w-0">
            <h1 className="break-all text-xl font-semibold tracking-tight text-foreground sm:text-2xl">
              {tool.title ?? tool.annotations?.title ?? tool.name}
            </h1>
            <code className="mt-1 block break-all font-mono text-xs text-muted-foreground">
              {tool.name}
            </code>
            {tool.description ? (
              <p className="mt-2.5 max-w-3xl text-sm leading-6 text-muted-foreground">
                {tool.description}
              </p>
            ) : null}
          </div>
        </div>
      </header>

      <McpToolCatalog tools={[tool]} labels={labels} />

      {discoveryFailed ? (
        <p role="alert" className="text-sm text-destructive">
          {t("toolDiscoveryFailed")}
        </p>
      ) : null}
      {running ? (
        <section className="rounded-xl border border-border bg-card p-4 sm:p-5">
          <h2 className="mb-4 text-sm font-semibold">
            {t("manualToolTesting")}
          </h2>
          <ToolPlayground
            key={tool.name}
            workspace={slug}
            deploymentId={deployment.id}
            tools={[tool]}
            defaultRuntime
          />
        </section>
      ) : (
        <p className="text-sm text-muted-foreground">
          {t("deploymentNotRunningTesting", { status })}
        </p>
      )}

      {tools.length > 1 ? (
        <section className="rounded-xl border border-border bg-card p-4 sm:p-5">
          <h2 className="text-sm font-semibold text-foreground">
            {t("tools")}
          </h2>
          <div className="mt-3 grid gap-1 sm:grid-cols-2">
            {tools
              .filter((candidate) => candidate.name !== tool.name)
              .map((candidate) => (
                <Link
                  key={candidate.name}
                  href={`${base}/tools/${encodeURIComponent(candidate.name)}`}
                  className="flex min-w-0 items-center gap-2 rounded-lg px-3 py-2 text-xs text-muted-foreground hover:bg-muted/35 hover:text-foreground"
                >
                  <code className="min-w-0 flex-1 truncate font-mono">
                    {candidate.name}
                  </code>
                  <ChevronRight className="size-3.5 shrink-0" />
                </Link>
              ))}
          </div>
        </section>
      ) : null}
    </DashboardPage>
  );
}
