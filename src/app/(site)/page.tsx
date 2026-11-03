import type { Metadata } from "next";
import { getLocale } from "next-intl/server";
import { HomeView } from "@/components/home/HomeView";
import { getMarketingContent } from "@/lib/marketing/content";
import { SITE } from "@/lib/site";
import { siteMetadata } from "./_lib/metadata";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getLocale();
  const { home } = getMarketingContent(locale);
  return siteMetadata({
    title: `${SITE.name} | ${home.eyebrow}`,
    description: home.description,
    path: "/",
  });
}

export default function Home() {
  return <HomeView />;
}
