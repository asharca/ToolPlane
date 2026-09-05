'use client';

import { useTranslations } from 'next-intl';
import { CopyButton as UiCopyButton } from '@asharca/ui';

export function CopyButton({
  text,
  label = 'Copy',
  className,
  iconOnly = false,
}: {
  text: string;
  label?: string;
  className?: string;
  iconOnly?: boolean;
}) {
  const t = useTranslations('console.common');
  return (
    <UiCopyButton
      text={text}
      label={label}
      copiedLabel={t('copied')}
      failedLabel={t('copyFailed')}
      className={className}
      iconOnly={iconOnly}
    />
  );
}
