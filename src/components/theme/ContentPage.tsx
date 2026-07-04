import type { ReactNode } from 'react';

export function ContentPage({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto max-w-3xl px-4 py-12 sm:py-16">
      <h1 className="mb-6 text-3xl font-bold tracking-tight text-foreground">
        {title}
      </h1>
      <div className="ui-panel space-y-4 p-5 text-sm leading-relaxed text-muted-foreground sm:p-6">
        {children}
      </div>
    </div>
  );
}
