import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

export interface ContentPageProps {
  title: string;
  children: ReactNode;
}

export function ContentPage({ title, children }: ContentPageProps) {
  const t = useTranslations("errors");
  return (
    <article className="mx-auto max-w-3xl px-4 py-12">
      <Link
        href="/"
        className="mb-6 inline-flex items-center gap-1.5 rounded-md text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ArrowLeft className="size-3.5" aria-hidden="true" />
        {t("backHome")}
      </Link>
      <h1 className="mb-8 text-3xl font-semibold tracking-tight text-foreground">
        {title}
      </h1>
      <div className="space-y-6 text-sm leading-7 text-foreground/85 [&_h2]:mb-3 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:text-foreground [&_section]:space-y-3 [&_a]:underline [&_a]:underline-offset-4 [&_ul]:list-disc [&_ul]:pl-5">
        {children}
      </div>
    </article>
  );
}
