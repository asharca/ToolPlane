import { startUrl } from "@/lib/remote-mcp/oauth/protocol";
import { resolveWorkspaceScope } from "@/lib/workspace/scope";
import { redirect } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getDeployments } from "@/lib/workspace/queries";
import { effectiveStatus } from "@/lib/process/supervisor";
import { deploymentLabel } from "@/lib/workspace/deployment-label";
import { ProvisioningRefresher } from "@/components/dashboard/ProvisioningRefresher";
import { DashboardHeader } from "@/components/dashboard/DashboardHeader";
import { DashboardPage } from "@/components/dashboard/DashboardUI";
import { McpDeploymentsBrowser } from "@/components/dashboard/McpDeploymentsBrowser";
import { formatInTimeZone, resolveUserTimeZone } from "@/lib/timezone";
import { getTransportSettings } from "@/lib/admin/transport-settings";

export const dynamic = "force-dynamic";

function formatDate(d: Date, timeZone: string, locale: string): string {
  return formatInTimeZone(
    d,
    timeZone,
    {
      month: "short",
      day: "numeric",
      year: "numeric",
    },
    locale,
  );
}

export default async function McpServersPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ create?: string; error?: string }>;
}) {
  const [{ workspace: slug }, query] = await Promise.all([
    params,
    searchParams,
  ]);
  const [t, locale] = await Promise.all([
    getTranslations("console.mcp"),
    getLocale(),
  ]);
  const user = await getCurrentUser();
  if (!user) redirect("/app/login");
  const timeZone = resolveUserTimeZone(user);
  const ws = await resolveWorkspaceScope({ slug }, user.id);
  if (!ws) redirect("/app");
  const [deployments, { allowHttp }] = await Promise.all([
    getDeployments(ws.id),
    getTransportSettings(),
  ]);
  const deploymentItems = deployments.map((deployment) => {
    const label = deploymentLabel(deployment);
    return {
      id: deployment.id,
      name: label.name,
      source: label.source,
      reference:
        deployment.pinnedPackage ?? deployment.server?.slug ?? label.ref,
      status: effectiveStatus(deployment.id, deployment.status),
      createdAt: formatDate(deployment.createdAt, timeZone, locale),
      iconUrl: deployment.server?.iconUrl ?? null,
      signInUrl: deployment.oauth ? startUrl(slug, deployment.id) : null,
    };
  });
  const anyProvisioning = deploymentItems.some(
    (deployment) => deployment.status === "provisioning",
  );

  return (
    <>
      <DashboardHeader title={t("title")} />
      <ProvisioningRefresher active={anyProvisioning} />
      <DashboardPage className="flex min-h-0 flex-1 flex-col gap-5 space-y-0">
        {query.error === "unsafeHttpConfirmationRequired" && !allowHttp ? (
          <p role="alert" className="text-sm text-destructive">
            {t("unsafeHttpConsentDescription")}
          </p>
        ) : query.error === "mcpVersionResolutionFailed" ? (
          <p role="alert" className="text-sm text-destructive">
            {t("mcpVersionResolutionFailed")}
          </p>
        ) : null}

        <McpDeploymentsBrowser
          slug={slug}
          deployments={deploymentItems}
          allowHttp={allowHttp}
          defaultCreateOpen={query.create === "1"}
        />
      </DashboardPage>
    </>
  );
}
