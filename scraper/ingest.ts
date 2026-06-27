import { db } from '@/lib/db';
import type { ParsedServerCard } from './parse';

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

async function categoryConnect(name: string | null) {
  if (!name) return undefined;
  const slug = slugify(name);
  return {
    connectOrCreate: [{ where: { slug }, create: { slug, name } }],
  };
}

export async function upsertServer(card: ParsedServerCard): Promise<void> {
  const existingServer = await db.server.findUnique({ where: { slug: card.slug }, select: { curated: true } });
  if (existingServer?.curated) return;
  const categories = await categoryConnect(card.category);
  await db.server.upsert({
    where: { slug: card.slug },
    create: {
      slug: card.slug,
      name: card.name,
      author: card.author,
      description: card.description,
      iconUrl: card.iconUrl,
      stars: card.stars,
      ...(categories ? { categories } : {}),
    },
    update: {
      name: card.name,
      author: card.author,
      description: card.description,
      iconUrl: card.iconUrl,
      stars: card.stars,
      ...(categories ? { categories: { set: [], ...categories } } : {}),
    },
  });
}

export async function upsertClient(card: ParsedServerCard): Promise<void> {
  await db.client.upsert({
    where: { slug: card.slug },
    create: {
      slug: card.slug,
      name: card.name,
      author: card.author,
      description: card.description,
      iconUrl: card.iconUrl,
      stars: card.stars,
    },
    update: {
      name: card.name,
      author: card.author,
      description: card.description,
      iconUrl: card.iconUrl,
      stars: card.stars,
    },
  });
}

export async function upsertSkill(card: ParsedServerCard): Promise<void> {
  const existingSkill = await db.skill.findUnique({ where: { slug: card.slug }, select: { curated: true } });
  if (existingSkill?.curated) return;
  await db.skill.upsert({
    where: { slug: card.slug },
    create: {
      slug: card.slug,
      name: card.name,
      author: card.author,
      description: card.description,
      iconUrl: card.iconUrl,
      score: card.stars,
    },
    update: {
      name: card.name,
      author: card.author,
      description: card.description,
      iconUrl: card.iconUrl,
      score: card.stars,
    },
  });
}

export async function enrichServer(
  slug: string,
  detail: { categories: { name: string; slug: string }[]; isOfficial: boolean },
): Promise<void> {
  await db.server.update({
    where: { slug },
    data: {
      ...(detail.isOfficial ? { isOfficial: true } : {}),
      categories: {
        connectOrCreate: detail.categories.map((c) => ({
          where: { slug: c.slug },
          create: { slug: c.slug, name: c.name },
        })),
      },
    },
  });
}

export async function setCheckpoint(
  job: string,
  lastSlug: string,
  doneCount: number,
): Promise<void> {
  await db.scrapeCheckpoint.upsert({
    where: { job },
    create: { job, lastSlug, doneCount },
    update: { lastSlug, doneCount },
  });
}
