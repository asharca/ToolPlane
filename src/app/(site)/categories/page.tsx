import Link from 'next/link';
import type { LucideIcon } from 'lucide-react';
import {
  ChevronRight,
  Wrench,
  Plug,
  LineChart,
  Shield,
  Rocket,
  BarChart3,
  Globe,
  Database,
  Brain,
  Palette,
  Gamepad2,
  Smartphone,
  BookOpen,
  Megaphone,
  Users,
  LayoutGrid,
} from 'lucide-react';
import { listCategories } from '@/lib/queries/categories';

export const dynamic = 'force-dynamic';

function iconFor(name: string): LucideIcon {
  const n = name.toLowerCase();
  if (n.includes('developer')) return Wrench;
  if (n.includes('api')) return Plug;
  if (n.includes('data science') || n.includes('ml')) return LineChart;
  if (n.includes('security')) return Shield;
  if (n.includes('deployment') || n.includes('devops')) return Rocket;
  if (n.includes('analytics') || n.includes('monitoring')) return BarChart3;
  if (n.includes('scraping') || n.includes('web')) return Globe;
  if (n.includes('database')) return Database;
  if (n.includes('content')) return BookOpen;
  if (n.includes('design')) return Palette;
  if (n.includes('game')) return Gamepad2;
  if (n.includes('mobile')) return Smartphone;
  if (n.includes('learning') || n.includes('documentation')) return BookOpen;
  if (n.includes('marketing')) return Megaphone;
  if (n.includes('collaboration')) return Users;
  if (n.includes('productivity') || n.includes('workflow')) return Brain;
  return LayoutGrid;
}

export default async function Page() {
  const categories = await listCategories();

  return (
    <div className="mx-auto max-w-screen-xl px-4 py-8">
      <nav className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <Link href="/" className="transition-colors hover:text-foreground">
          Home
        </Link>
        <ChevronRight className="size-3.5" />
        <span className="text-foreground">Categories</span>
      </nav>

      <header className="mt-6">
        <h1 className="font-mono text-4xl font-bold tracking-tight sm:text-6xl">
          <span className="text-foreground">Browse by</span>{' '}
          <span className="text-muted-foreground">Category</span>
        </h1>
        <p className="mt-4 max-w-2xl text-base leading-relaxed text-muted-foreground">
          Explore the directory organized by category to find the right Model
          Context Protocol server for your needs.
        </p>
      </header>

      {categories.length === 0 ? (
        <p className="mt-8 text-sm text-muted-foreground">
          No categories yet. Run detail enrichment to populate them.
        </p>
      ) : (
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {categories.map((c) => {
            const Icon = iconFor(c.name);
            return (
              <Link
                key={c.slug}
                href={`/categories/${c.slug}`}
                className="rounded-lg border border-border p-5 transition-colors hover:bg-accent/50"
              >
                <Icon className="size-5 text-muted-foreground" />
                <h2 className="mt-3 font-mono text-lg font-bold text-foreground">
                  {c.name}
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  <span className="text-foreground">
                    {c._count.servers.toLocaleString()}
                  </span>{' '}
                  MCP servers
                </p>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
