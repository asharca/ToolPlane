import Link from 'next/link';
import { Logo } from '@/components/layout/Logo';
import { ThemeToggle } from '@/components/theme/ThemeToggle';

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <header className="flex h-14 items-center justify-between px-6">
        <Link href="/" className="group flex items-center gap-2">
          <Logo svgSize={28} wordmarkClass="text-lg" />
        </Link>
        <ThemeToggle />
      </header>
      <main className="flex flex-1 items-center justify-center px-4 pb-16">
        {children}
      </main>
    </div>
  );
}
