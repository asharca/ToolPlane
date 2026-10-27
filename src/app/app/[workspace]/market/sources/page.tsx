import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ButtonLink } from "@/components/motion/button";
import {
  DashboardPage,
  DashboardPanel,
} from "@/components/dashboard/DashboardUI";
import {
  GithubResourceRegistryCredentialsForm,
  GithubResourceRegistryForm,
  GithubResourceRegistrySyncForm,
  GithubResourceRegistryWebhookForm,
} from "@/components/dashboard/market/GithubResourceRegistryForms";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getWorkspaceForUser } from "@/lib/workspace/queries";
import { db } from "@/lib/db";
import { listGithubResourceRegistries } from "@/lib/market/github-registry";

export const dynamic = "force-dynamic";

export default async function GithubResourceSourcesPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const [{ workspace: slug }, user, t] = await Promise.all([
    params,
    getCurrentUser(),
    getTranslations("console.market.githubRegistry"),
  ]);
  if (!user)
    redirect(
      `/app/login?next=${encodeURIComponent(`/app/${slug}/market/sources`)}`,
    );
  const workspace = await getWorkspaceForUser(slug, user.id);
  if (!workspace) redirect("/app");
  const [registries, membership] = await Promise.all([
    listGithubResourceRegistries({
      workspaceId: workspace.id,
      userId: user.id,
    }),
    workspace.ownerId === user.id
      ? null
      : db.membership.findUnique({
          where: {
            workspaceId_userId: { workspaceId: workspace.id, userId: user.id },
          },
          select: { role: true },
        }),
  ]);
  const canManage =
    workspace.ownerId === user.id || membership?.role === "admin";
  const base = `/app/${encodeURIComponent(slug)}/market`;
  return (
    <DashboardPage className="space-y-6">
      <header className="space-y-3">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
          {t("description")}
        </p>
        <div className="flex flex-wrap gap-2">
          <ButtonLink href={base} variant="secondary" size="sm">
            {t("browse")}
          </ButtonLink>
          <ButtonLink href={`${base}/publish`} variant="ghost" size="sm">
            {t("manageListings")}
          </ButtonLink>
        </div>
      </header>
      <section className="space-y-4" aria-label={t("configured")}>
        <h2 className="text-lg font-semibold">{t("configured")}</h2>
        {!registries.length ? (
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        ) : (
          registries.map((registry) => (
            <DashboardPanel key={registry.id} title={registry.name}>
              <div className="space-y-4">
                <a
                  href={`https://github.com/${registry.repository}/tree/${encodeURIComponent(registry.branch)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="break-all text-sm font-medium hover:underline"
                >
                  {registry.repository} · {registry.branch}
                </a>
                <dl className="grid gap-4 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="text-muted-foreground">{t("status")}</dt>
                    <dd>
                      {t.has(`statuses.${registry.status}`)
                        ? t(`statuses.${registry.status}`)
                        : registry.status}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{t("visibility")}</dt>
                    <dd>
                      {t(
                        registry.visibility === "public" ? "public" : "private",
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{t("lastSync")}</dt>
                    <dd>
                      {registry.lastSyncAt ? (
                        <time
                          dateTime={new Date(registry.lastSyncAt).toISOString()}
                        >
                          {new Date(registry.lastSyncAt).toISOString()}
                        </time>
                      ) : (
                        t("notSynced")
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">
                      {t("credentials")}
                    </dt>
                    <dd>
                      {t(
                        registry.hasCredentials
                          ? "credentialsConfigured"
                          : "noCredentials",
                      )}
                    </dd>
                  </div>
                  <div className="min-w-0 sm:col-span-2">
                    <dt className="text-muted-foreground">{t("commit")}</dt>
                    <dd className="break-all font-mono">
                      {registry.lastAppliedCommit ? (
                        <a
                          href={`https://github.com/${registry.repository}/commit/${registry.lastAppliedCommit}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="hover:underline"
                        >
                          {registry.lastAppliedCommit}
                        </a>
                      ) : (
                        t("notSynced")
                      )}
                    </dd>
                  </div>
                </dl>
                {registry.error ? (
                  <p
                    role="alert"
                    className="break-words text-sm text-destructive"
                  >
                    {t.has(`errors.${registry.error}`)
                      ? t(`errors.${registry.error}`)
                      : registry.error}
                  </p>
                ) : null}
                {canManage ? (
                  <div className="space-y-4">
                    <GithubResourceRegistrySyncForm
                      workspace={slug}
                      registryId={registry.id}
                      disabled={
                        registry.status === "pending" ||
                        registry.status === "syncing"
                      }
                    />
                    <GithubResourceRegistryWebhookForm
                      workspace={slug}
                      registryId={registry.id}
                    />
                    <GithubResourceRegistryCredentialsForm
                      workspace={slug}
                      registryId={registry.id}
                    />
                  </div>
                ) : null}
              </div>
            </DashboardPanel>
          ))
        )}
      </section>
      <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
        {t("immutableHelp")}
      </p>
      {canManage ? (
        <DashboardPanel title={t("add")}>
          <GithubResourceRegistryForm workspace={slug} />
        </DashboardPanel>
      ) : (
        <p className="text-sm text-muted-foreground">{t("managerRequired")}</p>
      )}
    </DashboardPage>
  );
}
