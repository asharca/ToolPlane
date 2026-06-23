import { db } from '@/lib/db';
import type { ParsedServerCard } from './parse';

function slugify(name: string): string {
  return name.toLowerCase().trim().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

async function categoryConnect(name: string | null) {
  if (!name) return undefined;
  const slug = slugify(name);
  return {
    connectOrCreate: [{ where: { slug }, create: { slug, name } }],
  };
}

export async function upsertServer(card: ParsedServerCard): Promise<void> {
  const categories = await categoryConnect(card.category);
  await db.server.upsert({
    where: { slug: card.slug },
    create: {
      slug: card.slug, name: card.name, author: card.author,
      description: card.description, iconUrl: card.iconUrl, stars: card.stars,
      ...(categories ? { categories } : {}),
    },
    update: {
      name: card.name, author: card.author, description: card.description,
      iconUrl: card.iconUrl, stars: card.stars,
      ...(categories ? { categories: { set: [], ...categories } } : {}),
    },
  });
}

export async function setCheckpoint(job: string, lastSlug: string, doneCount: number): Promise<void> {
  await db.scrapeCheckpoint.upsert({
    where: { job },
    create: { job, lastSlug, doneCount },
    update: { lastSlug, doneCount },
  });
}
