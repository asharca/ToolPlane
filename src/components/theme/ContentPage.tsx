import type { ReactNode } from 'react';

export function ContentPage({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto max-w-4xl px-3 py-8 sm:py-12">
      <h1 className="mb-5 text-3xl font-semibold tracking-[-0.03em] text-foreground">
        {title}
      </h1>
      <div className="ui-panel space-y-5 p-5 text-sm leading-6 text-muted-foreground sm:p-7">
        {children}
      </div>
    </div>
  );
}
