import type { ReactNode } from "react";

export interface ContentPageProps {
  title: string;
  children: ReactNode;
}

export function ContentPage({ title, children }: ContentPageProps) {
  return (
    <article className="mx-auto max-w-3xl px-4 py-12">
      <h1 className="mb-8 text-3xl font-semibold tracking-tight text-foreground">
        {title}
      </h1>
      <div className="space-y-6 text-sm leading-7 text-muted-foreground [&_h2]:mb-3 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:text-foreground [&_section]:space-y-3 [&_a]:underline [&_a]:underline-offset-4 [&_ul]:list-disc [&_ul]:pl-5">
        {children}
      </div>
    </article>
  );
}
