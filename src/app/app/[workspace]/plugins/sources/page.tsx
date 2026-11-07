import Link from "next/link";
import { redirect } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { ArrowLeft, GitBranch } from "lucide-react";
import {
  DashboardEmptyState,
  DashboardPage,
  DashboardToolbar,
} from "@/components/dashboard/DashboardUI";
import {
  PluginActionForm,
  PluginSourceCreateDialog,
  PluginWebhook,
} from "@/components/dashboard/plugins/PluginForms";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getWorkspaceForUser } from "@/lib/workspace/queries";
import { db } from "@/lib/db";
import { listPluginSources } from "@/lib/plugins/sources";

export const dynamic = "force-dynamic";

const pluginFieldClass =
  "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm";
const externalLinkClass =
  "font-medium text-foreground underline-offset-4 hover:underline";

export default async function PluginSourcesPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const [{ workspace: slug }, user, t, locale] = await Promise.all([
    params,
    getCurrentUser(),
    getTranslations("console.plugins"),
    getLocale(),
  ]);
  const base = `/app/${encodeURIComponent(slug)}/plugins`;
  if (!user)
    redirect(`/app/login?next=${encodeURIComponent(`${base}/sources`)}`);
  const workspace = await getWorkspaceForUser(slug, user.id);
  if (!workspace) redirect("/app");
  const [sources, membership] = await Promise.all([
    listPluginSources(workspace.id, user.id),
    db.membership.findUnique({
      where: {
        workspaceId_userId: { workspaceId: workspace.id, userId: user.id },
      },
      select: { role: true },
    }),
  ]);
  const canManage =
    workspace.ownerId === user.id ||
    membership?.role === "admin" ||
    membership?.role === "owner";
  const dateFormat = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  return (
    <DashboardPage>
      <Link
        href={base}
        className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        {t("title")}
      </Link>
      <DashboardToolbar
        actions={
          canManage ? <PluginSourceCreateDialog workspace={slug} /> : null
        }
      >
        <h1 className="text-xl font-semibold">{t("sourcesTitle")}</h1>
        <p className="text-sm text-muted-foreground">
          {t.rich("marketGuide", {
            fork: (chunks) => (
              <a
                href="https://github.com/asharca/toolplane-plugins/fork"
                target="_blank"
                rel="noopener noreferrer"
                className={externalLinkClass}
              >
                {chunks}
              </a>
            ),
            contribute: (chunks) => (
              <a
                href="https://github.com/asharca/toolplane-plugins/blob/main/CONTRIBUTING.md"
                target="_blank"
                rel="noopener noreferrer"
                className={externalLinkClass}
              >
                {chunks}
              </a>
            ),
          })}
        </p>
      </DashboardToolbar>
      {sources.length ? (
        <ul className="space-y-3">
          {sources.map((source) => {
            const tone =
              source.status === "ready" || source.status === "synced"
                ? "bg-(--color-success)/10 text-(--color-success)"
                : source.status === "error" || source.status === "failed"
                  ? "bg-destructive/10 text-destructive"
                  : "bg-muted text-muted-foreground";
            const commit = source.lastAppliedCommit;
            return (
              <li
                key={source.id}
                className="rounded-xl border border-border bg-card px-5 py-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="font-semibold">
                        {source.official ? t("officialSource") : source.name}
                      </h2>
                      {source.official ? (
                        <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">
                          {t("official")}
                        </span>
                      ) : null}
                      {source.visibility === "private" ? (
                        <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                          {t("private")}
                        </span>
                      ) : null}
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs ${tone}`}
                      >
                        {t.has(`sourceStatuses.${source.status}`)
                          ? t(`sourceStatuses.${source.status}`)
                          : source.status}
                      </span>
                    </div>
                    <a
                      className="inline-flex min-w-0 items-center gap-1.5 break-words text-sm hover:underline"
                      href={`https://github.com/${source.repository}/tree/${encodeURIComponent(source.branch)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <GitBranch className="size-3.5 shrink-0" />
                      {source.repository} · {source.branch}
                    </a>
                    <p className="text-xs text-muted-foreground">
                      {source.lastSyncAt ? (
                        <>
                          {t("lastSync")}{" "}
                          <time dateTime={source.lastSyncAt.toISOString()}>
                            {dateFormat.format(source.lastSyncAt)}
                          </time>
                          {commit ? (
                            <>
                              {" · "}
                              {t("commit")}{" "}
                              <a
                                className="font-mono hover:underline"
                                href={`https://github.com/${source.repository}/commit/${commit}`}
                                target="_blank"
                                rel="noopener noreferrer"
                              >
                                {commit.slice(0, 7)}
                              </a>
                            </>
                          ) : null}
                        </>
                      ) : (
                        t("neverSynced")
                      )}
                    </p>
                  </div>
                  {source.canSync ? (
                    <PluginActionForm
                      workspace={slug}
                      operation="source-sync"
                      id={source.id}
                      label={t("syncNow")}
                    />
                  ) : null}
                </div>
                {source.error ? (
                  <p
                    role="alert"
                    className="mt-3 break-words rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
                  >
                    {t.has(`errors.${source.error}`)
                      ? t(`errors.${source.error}`)
                      : t("errors.registry_sync_failed")}
                  </p>
                ) : null}
                {!source.official && canManage ? (
                  <details className="mt-3 border-t border-border pt-3">
                    <summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground">
                      {t("settings")}
                    </summary>
                    <div className="mt-4 space-y-5">
                      <section className="space-y-2">
                        <h3 className="text-sm font-medium">
                          {t("credentials")}
                          {source.hasCredentials ? (
                            <span className="ml-2 font-normal text-muted-foreground">
                              {t("configured")}
                            </span>
                          ) : null}
                        </h3>
                        <PluginActionForm
                          workspace={slug}
                          operation="source-credentials"
                          id={source.id}
                          label={t("replaceCredentials")}
                        >
                          <input
                            type="password"
                            name="token"
                            aria-label={t("token")}
                            placeholder={t("token")}
                            autoComplete="off"
                            className={pluginFieldClass}
                            required={source.visibility === "private"}
                            maxLength={4096}
                          />
                        </PluginActionForm>
                      </section>
                      <section className="space-y-2">
                        <h3 className="text-sm font-medium">{t("webhook")}</h3>
                        {source.webhook ? (
                          <PluginWebhook
                            path={source.webhook.path}
                            secret={source.webhook.secret}
                          />
                        ) : (
                          <p className="text-sm text-muted-foreground">
                            {t("webhookUnavailable")}
                          </p>
                        )}
                      </section>
                      <div className="border-t border-border pt-3">
                        <PluginActionForm
                          workspace={slug}
                          operation="source-delete"
                          id={source.id}
                          label={t("deleteSource")}
                          variant="ghost"
                          destructive
                          confirm
                        />
                      </div>
                    </div>
                  </details>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <DashboardEmptyState icon={GitBranch} title={t("sourcesEmpty")} />
      )}
    </DashboardPage>
  );
}
