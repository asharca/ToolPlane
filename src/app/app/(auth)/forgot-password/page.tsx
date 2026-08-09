import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { ForgotPasswordForm } from '@/components/auth/PasswordRecoveryForms';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth');
  return { title: t('forgotPasswordMetadata'), robots: { index: false, follow: true } };
}

export default function ForgotPasswordPage() {
  return <ForgotPasswordForm />;
}
