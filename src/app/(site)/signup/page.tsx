import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { AuthForm } from '@/components/auth/AuthForm';
import { signupAction } from '@/lib/auth/actions';
import { getCurrentUser } from '@/lib/auth/current-user';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Sign up | MCP Market' };

export default async function Page() {
  if (await getCurrentUser()) redirect('/account');
  return <AuthForm mode="signup" action={signupAction} />;
}
