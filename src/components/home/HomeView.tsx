import { getLocale } from "next-intl/server";
import { getMarketingContent } from "@/lib/marketing/content";
import { LandingHero } from "./LandingHero";
import { LandingShowcase } from "./LandingShowcase";

export async function HomeView() {
  const locale = await getLocale();
  const content = getMarketingContent(locale);

  return (
    <div className="min-w-0">
      <LandingHero home={content.home} locale={locale} />
      <LandingShowcase content={content} />
    </div>
  );
}
