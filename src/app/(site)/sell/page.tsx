import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { SITE } from '@/lib/site';

export function generateMetadata(): Metadata {
  return {
    title: `Source code | ${SITE.name}`,
  };
}

export default function Page() {
  redirect(SITE.sourceUrl);
}
