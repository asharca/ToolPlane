import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { AuthForm } from '@/components/auth/AuthForm';
import { signupAction } from '@/lib/auth/actions';
import { getCurrentUser } from '@/lib/auth/current-user';
import { safeRelativePath } from '@/lib/auth/safe-redirect';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Sign up | MCP Market' };

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const next = safeRelativePath((await searchParams).next) ?? undefined;
  if (await getCurrentUser()) redirect(next ?? '/app');
  return <AuthForm mode="signup" action={signupAction} next={next} />;
}
