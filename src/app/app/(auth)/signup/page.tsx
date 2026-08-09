import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { AuthForm } from '@/components/auth/AuthForm';
import { signupAction } from '@/lib/auth/actions';
import { getCurrentUser } from '@/lib/auth/current-user';
import { safeRelativePath } from '@/lib/auth/safe-redirect';
import { getTranslations } from 'next-intl/server';

export const dynamic = 'force-dynamic';
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth');
  return { title: t('signupMetadata'), robots: { index: false, follow: true } };
}

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const next = safeRelativePath((await searchParams).next) ?? undefined;
  if (await getCurrentUser()) redirect(next ?? '/app');
  return <AuthForm mode="signup" action={signupAction} next={next} />;
}
