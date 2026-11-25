"use client";

import Link from "next/link";
import { ArrowLeft, RotateCcw } from "lucide-react";
import { useTranslations } from "next-intl";
import { Logo } from "@/components/layout/Logo";
import { Button, ButtonLink } from "@/components/motion/button";
import { SITE } from "@/lib/site";

export default function AppError({
  reset,
}: {
  error: Error;
  reset: () => void;
}) {
  const t = useTranslations("errors");
  return (
    <div className="flex min-h-dvh items-center justify-center bg-background px-4 py-16 text-foreground">
      <div className="w-full max-w-md text-center">
        <Link href="/" aria-label={SITE.name} className="inline-flex">
          <Logo />
        </Link>
        <h1 className="mt-8 text-2xl font-semibold tracking-tight">
          {t("serverError")}
        </h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          {t("serverErrorDesc")}
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-2.5">
          <Button type="button" onClick={reset}>
            <RotateCcw className="size-4" />
            {t("tryAgain")}
          </Button>
          <ButtonLink href="/" variant="secondary">
            <ArrowLeft className="size-4" />
            {t("backHome")}
          </ButtonLink>
        </div>
      </div>
    </div>
  );
}
