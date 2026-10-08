import type { Metadata } from 'next';
import Link from 'next/link';
import { Reference } from './reference';

export const metadata: Metadata = {
  title: 'API Reference | ToolPlane',
  description: 'Interactive ToolPlane API reference.',
};

export default function ApiReferencePage() {
  return <main>
    <nav aria-label="Documentation" className="border-b px-6 py-3 text-sm">
      <Link href="/docs/en" className="hover:underline">Back to documentation</Link>
    </nav>
    <Reference />
  </main>;
}
