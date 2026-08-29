import type { Metadata } from 'next';
import Link from 'next/link';
import type { LucideIcon } from 'lucide-react';
import {
  BarChart3,
  BookOpen,
  Brain,
  ChevronRight,
  Database,
  Gamepad2,
  Globe,
  LayoutGrid,
  LineChart,
  Megaphone,
  Palette,
  Plug,
  Rocket,
  Shield,
  Smartphone,
  Users,
  Wrench,
} from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { SITE } from '@/lib/site';
import { listPublicCategories } from '../_lib/catalog';
import { siteMetadata } from '../_lib/metadata';

function iconFor(name: string): LucideIcon {
  const value = name.toLowerCase();
  if (value.includes('developer')) return Wrench;
  if (value.includes('api')) return Plug;
  if (value.includes('data science') || value.includes('ml')) return LineChart;
  if (value.includes('security')) return Shield;
  if (value.includes('deployment') || value.includes('devops')) return Rocket;
  if (value.includes('analytics') || value.includes('monitoring')) return BarChart3;
  if (value.includes('scraping') || value.includes('web')) return Globe;
  if (value.includes('database')) return Database;
  if (value.includes('content') || value.includes('learning')) return BookOpen;
  if (value.includes('design')) return Palette;
  if (value.includes('game')) return Gamepad2;
  if (value.includes('mobile')) return Smartphone;
  if (value.includes('marketing')) return Megaphone;
  if (value.includes('collaboration')) return Users;
  if (value.includes('productivity') || value.includes('workflow')) return Brain;
  return LayoutGrid;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('categories');
  return siteMetadata({
    title: `${t('categories')} | ${SITE.name}`,
    description: t('exploreDirectoryByCategory'),
    path: '/categories',
  });
}

export default async function Page() {
  const [t, common, categories] = await Promise.all([
    getTranslations('categories'),
    getTranslations('common'),
    listPublicCategories(),
  ]);

  return (
    <div className="mx-auto max-w-screen-xl px-4 py-8">
      <nav className="flex items-center gap-1.5 text-sm text-muted-foreground" aria-label={common('breadcrumb')}>
        <Link href="/" className="transition-colors hover:text-foreground">{t('home')}</Link>
        <ChevronRight className="size-3.5" />
        <span className="text-foreground" aria-current="page">{t('categories')}</span>
      </nav>

      <header className="mt-6">
        <h1 className="font-mono text-4xl font-bold tracking-tight sm:text-6xl">
          <span className="text-foreground">{t('browseBy')}</span>{' '}
          <span className="text-muted-foreground">{t('category')}</span>
        </h1>
        <p className="mt-4 max-w-2xl text-base leading-relaxed text-muted-foreground">{t('exploreDirectoryByCategory')}</p>
      </header>

      {categories.length === 0 ? (
        <p className="mt-8 text-sm text-muted-foreground">{t('noCategoriesYetRunDetailEnrichmentToPopulateThem')}</p>
      ) : (
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {categories.map((category) => {
            const Icon = iconFor(category.name);
            return (
              <Link
                key={category.slug}
                href={`/categories/${category.slug}`}
                className="rounded-lg border border-border p-5 transition-colors hover:bg-accent/50"
              >
                <Icon className="size-5 text-muted-foreground" />
                <h2 className="mt-3 font-mono text-lg font-bold text-foreground">{category.name}</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {t('categoryCounts', {
                    servers: category._count.servers,
                    skills: category._count.skills,
                    agents: category._count.agentListings,
                    assistants: category._count.assistants,
                    toolkits: category._count.toolkits,
                  })}
                </p>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
