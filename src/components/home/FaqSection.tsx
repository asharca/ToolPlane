'use client';

import { useTranslations } from 'next-intl';
const FAQ_KEYS = ['faq1', 'faq2', 'faq3', 'faq4', 'faq5', 'faq6', 'faq7', 'faq8'] as const;

export function FaqSection() {
  const t = useTranslations('home');
  return (
    <section className="py-12">
      <h2 className="mb-6 text-xl font-semibold tracking-tight text-foreground">
        {t('frequentlyAskedQuestions')}
      </h2>
      <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
        {FAQ_KEYS.map((key) => (
          <details key={key} className="group px-5 py-4">
            <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-medium text-foreground">
              {t(`${key}.q`)}
              <span className="ml-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-45">
                +
              </span>
            </summary>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              {t(`${key}.a`)}
            </p>
          </details>
        ))}
      </div>
    </section>
  );
}
