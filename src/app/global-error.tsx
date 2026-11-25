"use client";

import { RotateCcw } from "lucide-react";
import { Logo } from "@/components/layout/Logo";

export default function GlobalError({
  reset,
}: {
  error: Error;
  reset: () => void;
}) {
  const isZh =
    typeof document !== "undefined" &&
    document.documentElement.lang.toLowerCase().startsWith("zh");
  const title = isZh ? "发生错误" : "Something went wrong";
  const description = isZh
    ? "发生了意外错误，请重试。"
    : "An unexpected error occurred. Please try again.";
  const retryLabel = isZh ? "重试" : "Try again";

  return (
    <html lang={isZh ? "zh" : "en"} className="dark">
      <body className="flex min-h-dvh items-center justify-center bg-[#151515] px-4 py-16 text-[#f2f2f2] antialiased">
        <div className="w-full max-w-md text-center">
          <div className="inline-flex">
            <Logo />
          </div>
          <h1 className="mt-8 text-2xl font-semibold tracking-tight">
            {title}
          </h1>
          <p className="mt-2 text-sm leading-6 text-[#868686]">{description}</p>
          <div className="mt-6 flex justify-center">
            <button
              type="button"
              onClick={reset}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-[#006fd6] px-5 text-sm font-medium text-white transition-colors hover:bg-[#006fd6]/90"
            >
              <RotateCcw className="size-4" />
              {retryLabel}
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
