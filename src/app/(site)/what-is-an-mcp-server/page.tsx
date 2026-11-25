import { ArrowRight } from "lucide-react";
import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";
import { ButtonLink } from "@/components/motion/button";
import { ContentPage } from "@/components/theme/ContentPage";
import { getMarketingContent } from "@/lib/marketing/content";
import { siteMetadata } from "../_lib/metadata";

export async function generateMetadata(): Promise<Metadata> {
  const [t, locale] = await Promise.all([
    getTranslations("metadata"),
    getLocale(),
  ]);
  const { mcpGuide } = getMarketingContent(locale);
  return siteMetadata({
    title: t("whatIsAnMcpServerToolplane"),
    description: mcpGuide.metaDescription,
    path: "/what-is-an-mcp-server",
  });
}

export default async function Page() {
  const [t, locale] = await Promise.all([
    getTranslations("aboutMcp"),
    getLocale(),
  ]);
  const { mcpGuide } = getMarketingContent(locale);

  return (
    <ContentPage title={t("whatIsMcp")}>
      <p>
        {t(
          "anMcpModelContextProtocolServerIsASmallProgramThatExposesToolsDataAndPromptsToAiApplicationsThroughASingleStandardInterfaceInsteadOfBuildingACustomIntegrationForEveryServiceAnAiAppCanConnectToAnyMcpServerAndImmediatelyUseWhatItOffers",
        )}
      </p>
      <p>
        {t(
          "aClientInsideTheAiAppConnectsToTheServerOverATransportSuchAsStdioOrStreamableHttpTheServerAdvertisesItsCapabilitiesForExampleQueryingADatabaseCallingAnApiOrReadingFilesAndTheModelCanDiscoverAndInvokeThemAtRuntime",
        )}
      </p>
      <p>
        {t(
          "becauseTheProtocolIsStandardizedTheSameServerWorksAcrossAnyMcpcompatibleClientAndDevelopersCanExtendWhatTheirAiCanDoSimplyByAddingMoreServers",
        )}
      </p>

      {mcpGuide.sections.map((section) => (
        <section key={section.title}>
          <h2>{section.title}</h2>
          <p>{section.body}</p>
        </section>
      ))}

      <section className="mt-8 rounded-2xl border border-border-strong bg-card p-6">
        <h2 className="mb-1.5 text-base font-semibold text-foreground">
          {mcpGuide.ctaTitle}
        </h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {mcpGuide.ctaDescription}
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <ButtonLink href="/app" size="sm" className="no-underline">
            {mcpGuide.openConsoleCta}
            <ArrowRight aria-hidden="true" className="size-3.5" />
          </ButtonLink>
          <ButtonLink
            href="/#mcp"
            variant="secondary"
            size="sm"
            className="no-underline"
          >
            {mcpGuide.exploreGatewayCta}
          </ButtonLink>
        </div>
      </section>
    </ContentPage>
  );
}
