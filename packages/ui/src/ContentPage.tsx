import type { ReactNode } from 'react';

export type ContentPageProps = {
  title: string;
  children: ReactNode;
};

export function ContentPage({ title, children }: ContentPageProps) {
  return (
    <div data-toolplane-ui="content-page" className="mx-auto max-w-4xl px-3 py-8 sm:py-12">
      <h1 className="mb-5 text-3xl font-semibold text-foreground">{title}</h1>
      <div className="ui-panel space-y-5 p-5 text-sm leading-6 text-muted-foreground sm:p-7">
        {children}
      </div>
    </div>
  );
}
