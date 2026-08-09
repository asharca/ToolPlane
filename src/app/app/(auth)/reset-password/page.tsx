import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { ResetPasswordForm } from '@/components/auth/PasswordRecoveryForms';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth');
  return {
    title: t('resetPasswordMetadata'),
    robots: { index: false, follow: true },
    referrer: 'no-referrer',
  };
}

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[] }>;
}) {
  const raw = (await searchParams).token;
  const token = typeof raw === 'string' ? raw : '';
  return <ResetPasswordForm token={token} />;
}
