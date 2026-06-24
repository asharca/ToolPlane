import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { AuthForm } from '@/components/auth/AuthForm';
import { signupAction } from '@/lib/auth/actions';
import { getCurrentUser } from '@/lib/auth/current-user';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Sign up | MCP Market' };

function safeNext(value: string | string[] | undefined): string | undefined {
  const next = Array.isArray(value) ? value[0] : value;
  if (
    next &&
    next.startsWith('/') &&
    !next.startsWith('//') &&
    !next.startsWith('/\\')
  ) {
    return next;
  }
  return undefined;
}

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const next = safeNext((await searchParams).next);
  if (await getCurrentUser()) redirect(next ?? '/account');
  return <AuthForm mode="signup" action={signupAction} next={next} />;
}
