import { getTranslations } from "next-intl/server";

export async function GithubResourceProvenance({
  summary,
}: {
  summary: unknown;
}) {
  if (!summary || typeof summary !== "object" || !("github" in summary))
    return null;
  const source = summary.github;
  if (
    !source ||
    typeof source !== "object" ||
    !("repository" in source) ||
    typeof source.repository !== "string" ||
    !("commit" in source) ||
    typeof source.commit !== "string" ||
    !("path" in source) ||
    typeof source.path !== "string" ||
    !("version" in source) ||
    typeof source.version !== "string"
  )
    return null;
  const t = await getTranslations("console.market.githubRegistry");
  const path = source.path.split("/").map(encodeURIComponent).join("/");
  return (
    <section className="space-y-3 rounded-lg border border-border p-4">
      <h2 className="text-sm font-semibold">{t("provenance")}</h2>
      <a
        href={`https://github.com/${source.repository}/tree/${encodeURIComponent(source.commit)}/${path}`}
        target="_blank"
        rel="noopener noreferrer"
        className="break-all text-sm font-medium hover:underline"
      >
        {source.repository}/{source.path} · {source.version}
      </a>
      <p className="break-all font-mono text-xs text-muted-foreground">
        {source.commit}
      </p>
    </section>
  );
}
