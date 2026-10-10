import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getDeployments, getWorkspaceForUser } from "@/lib/workspace/queries";
import { deploymentLabel } from "@/lib/workspace/deployment-label";
import { readMcpToolCatalog } from "@/lib/process/mcp-tool-catalog";
import { db } from "@/lib/db";
import {
  listPiPackageClientInstallations,
  piPackageBindingsSchema,
} from "@/lib/pi-packages/installations";
import { parsePiPackageReleaseManifest } from "@/lib/market/pi-package-manifest";
import { DashboardPage } from "@/components/dashboard/DashboardUI";
import { ButtonLink } from "@/components/motion/button";
import {
  PiClientInstallForm,
  PiClientRevokeForm,
} from "@/components/dashboard/market/PiClientInstallForm";
import type { PiClientRelease } from "@/components/dashboard/market/PiClientInstallForm";

export const dynamic = "force-dynamic";

export default async function PiPackageClientsPage({
  params,
}: {
  params: Promise<{ workspace: string; installId: string }>;
}) {
  const [{ workspace: slug, installId }, user, t] = await Promise.all([
    params,
    getCurrentUser(),
    getTranslations("console.market.piClients"),
  ]);
  if (!user)
    redirect(
      `/app/login?next=${encodeURIComponent(`/app/${slug}/market/installed/${installId}/clients`)}`,
    );
  const workspace = await getWorkspaceForUser(slug, user.id);
  if (!workspace) notFound();
  const [install, allInstallations, deployments] = await Promise.all([
    db.marketInstall.findFirst({
      where: {
        id: installId,
        targetWorkspaceId: workspace.id,
        listing: { kind: "pi-package" },
      },
      include: { currentRelease: true, listing: true },
    }),
    listPiPackageClientInstallations({
      workspaceId: workspace.id,
      userId: user.id,
    }),
    getDeployments(workspace.id),
  ]);
  if (!install) notFound();
  const installations = allInstallations.filter(
    (item) => item.marketInstallId === install.id,
  );
  const pinnedReleases = await db.marketRelease.findMany({
    where: {
      id: { in: installations.map((item) => item.releaseId) },
      listingId: install.listingId,
    },
    select: { id: true, version: true, checksum: true, reviewStatus: true },
  });
  let release: PiClientRelease | null = null;
  if (
    install.status === "ready" &&
    install.listing.status === "published" &&
    install.currentRelease.reviewStatus === "approved" &&
    (install.listing.visibility === "public" ||
      install.listing.publisherWorkspaceId === workspace.id)
  ) {
    try {
      const manifest = parsePiPackageReleaseManifest(
        install.currentRelease.manifest,
        install.currentRelease.checksum,
      );
      release = {
        id: install.currentRelease.id,
        version: install.currentRelease.version,
        name: manifest.package.name,
        sourceVersion: manifest.package.version,
        checksum: install.currentRelease.checksum,
        requirements: manifest.package.toolplane?.mcp ?? [],
      };
    } catch {
      /* Invalid releases stay unavailable; existing registrations remain revocable. */
    }
  }
  const options = deployments.map((deployment) => ({
    id: deployment.id,
    name: deploymentLabel(deployment).name,
    tools: readMcpToolCatalog(deployment.installCfg)
      .filter(
        (tool) =>
          deployment.mcpToolExposure !== "allowlist" ||
          deployment.mcpAllowedTools.includes(tool.name),
      )
      .map((tool) => tool.name),
  }));
  const map = install.resourceMap;
  const parsedBindings = piPackageBindingsSchema.safeParse(
    map && typeof map === "object" && !Array.isArray(map)
      ? map.mcpBindings
      : {},
  );
  const workspaceBindings = parsedBindings.success ? parsedBindings.data : {};
  const defaults =
    install.listing.publisherWorkspaceId === workspace.id
      ? workspaceBindings
      : {};
  return (
    <DashboardPage className="space-y-6">
      <ButtonLink
        href={`/app/${encodeURIComponent(slug)}/market/installed#install-${encodeURIComponent(install.id)}`}
        variant="ghost"
        size="sm"
      >
        {t("back")}
      </ButtonLink>
      <div>
        <h1 className="text-xl font-semibold">
          {t("title", { name: install.listing.name })}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">{t("description")}</p>
      </div>
      {release && release.requirements.length > 0 ? (
        <section
          id="workspace-bindings"
          className="space-y-4 rounded-lg border border-border p-4"
        >
          <h2 className="font-semibold">{t("workspaceBindingsTitle")}</h2>
          <PiClientInstallForm
            workspace={slug}
            marketInstallId={install.id}
            release={release}
            deployments={options}
            defaults={workspaceBindings}
            workspaceBindings
          />
        </section>
      ) : null}
      <section className="space-y-4 rounded-lg border border-border p-4">
        <h2 className="font-semibold">{t("newDevice")}</h2>
        {release ? (
          <>
            <ButtonLink
              href={`/api/v1/workspaces/${encodeURIComponent(slug)}/market/pi-packages/${encodeURIComponent(release.id)}/download`}
              variant="secondary"
              size="sm"
            >
              {t("artifactDownload")}
            </ButtonLink>
            <p className="text-xs text-muted-foreground">
              {t("artifactNoCredentials")}
            </p>
            <PiClientInstallForm
              workspace={slug}
              marketInstallId={install.id}
              release={release}
              deployments={options}
              defaults={defaults}
            />
          </>
        ) : (
          <p role="alert" className="text-sm text-destructive">
            {t("errors.pi_package_unavailable")}
          </p>
        )}
      </section>
      <section className="space-y-4">
        <h2 className="font-semibold">{t("registrations")}</h2>
        <a
          className="text-sm underline"
          href="/api/v1/pi-packages/installer"
          download="pi-package-install.mjs"
        >
          {t("downloadInstaller")}
        </a>
        {!installations.length ? (
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        ) : null}
        {installations.map((installation) => {
          const pinned = pinnedReleases.find(
            (item) => item.id === installation.releaseId,
          );
          const bindings = piPackageBindingsSchema.safeParse(
            installation.bindings,
          );
          return (
            <article
              key={installation.id}
              id={`client-${installation.id}`}
              className="space-y-3 rounded-lg border border-border p-4"
            >
              <h3 className="font-medium">
                {installation.label} · {installation.client}
              </h3>
              <p className="text-sm">
                {t(installation.status === "active" ? "active" : "revoked")} ·{" "}
                {t("pinnedRelease", { version: pinned?.version ?? "—" })}
              </p>
              <code className="block break-all text-xs">
                {installation.releaseId} · {pinned?.checksum}
              </code>
              <p className="text-xs text-muted-foreground">
                {t("lastUsed", {
                  time: installation.lastUsedAt?.toISOString() ?? "—",
                })}
              </p>
              {bindings.success ? (
                <ul className="space-y-1 text-xs">
                  {Object.entries(bindings.data).map(([key, binding]) => (
                    <li key={key}>
                      {key} →{" "}
                      {options.find((item) => item.id === binding.deploymentId)
                        ?.name ?? binding.deploymentId}
                      : {binding.tools.join(", ")}
                    </li>
                  ))}
                </ul>
              ) : null}
              <p className="text-xs text-muted-foreground">
                {t("localUninstall")}
              </p>
              <pre className="overflow-x-auto text-xs">{`node ./pi-package-install.mjs uninstall --config "$HOME/.config/toolplane/pi-packages/${installation.id}/config.json"`}</pre>
              {installation.status === "active" ? (
                <>
                  <p className="text-xs text-muted-foreground">
                    {t("localUpdate")}
                  </p>
                  <pre className="overflow-x-auto text-xs">{`node ./pi-package-install.mjs update --config "$HOME/.config/toolplane/pi-packages/${installation.id}/config.json"`}</pre>
                  {release && bindings.success ? (
                    <details>
                      <summary className="cursor-pointer text-sm font-medium">
                        {t("manualUpdate")}
                      </summary>
                      <div className="mt-3">
                        <PiClientInstallForm
                          key={`${installation.id}-${release.id}`}
                          workspace={slug}
                          marketInstallId={install.id}
                          release={release}
                          deployments={options}
                          defaults={{}}
                          existing={{
                            id: installation.id,
                            client: installation.client,
                            bindings: bindings.data,
                          }}
                        />
                      </div>
                    </details>
                  ) : null}
                  <PiClientRevokeForm
                    workspace={slug}
                    installationId={installation.id}
                  />
                </>
              ) : null}
            </article>
          );
        })}
      </section>
    </DashboardPage>
  );
}
