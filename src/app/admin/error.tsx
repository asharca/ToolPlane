"use client";

import { RotateCcw } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/motion/button";

export default function AdminError({
  reset,
}: {
  error: Error;
  reset: () => void;
}) {
  const t = useTranslations("errors");
  return (
    <div className="flex min-h-[50dvh] flex-1 items-center justify-center p-6">
      <div className="w-full max-w-md rounded-xl border border-border bg-card p-6 text-center">
        <h2 className="text-base font-semibold text-foreground">
          {t("serverError")}
        </h2>
        <p className="mt-1.5 text-sm text-muted-foreground">
          {t("serverErrorDesc")}
        </p>
        <div className="mt-5 flex justify-center">
          <Button type="button" size="sm" onClick={reset}>
            <RotateCcw className="size-3.5" />
            {t("tryAgain")}
          </Button>
        </div>
      </div>
    </div>
  );
}
