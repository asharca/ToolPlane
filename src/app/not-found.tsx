import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, Search } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { Logo } from "@/components/layout/Logo";
import { SITE } from "@/lib/site";
import { ButtonLink } from "@/components/motion/button";

export const metadata: Metadata = {
  title: `Page not found | ${SITE.name}`,
  robots: { index: false, follow: false, noarchive: true },
};

export default async function NotFound() {
  const [t, common] = await Promise.all([
    getTranslations("errors"),
    getTranslations("common"),
  ]);
  return (
    <div className="flex min-h-dvh items-center justify-center bg-background px-4 py-16 text-foreground">
      <div className="w-full max-w-lg text-center">
        <Link href="/" aria-label={SITE.name} className="inline-flex">
          <Logo />
        </Link>
        <p className="mt-10 font-mono text-sm font-semibold tracking-[0.2em] text-primary">
          404
        </p>
        <h1 className="mt-3 text-4xl font-semibold tracking-tight sm:text-5xl">
          {t("notFound")}
        </h1>
        <p className="mx-auto mt-4 max-w-md text-base leading-7 text-muted-foreground">
          {t("notFoundDesc")}
        </p>
        <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
          <ButtonLink href="/" size="lg">
            <ArrowLeft className="size-4" />
            {t("backHome")}
          </ButtonLink>
          <ButtonLink href="/search" variant="secondary" size="lg">
            <Search className="size-4" />
            {common("search")}
          </ButtonLink>
        </div>
      </div>
    </div>
  );
}
