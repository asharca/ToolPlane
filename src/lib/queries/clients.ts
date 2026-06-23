import { db } from '@/lib/db';

export async function listClients() {
  return db.client.findMany({ orderBy: { stars: 'desc' } });
}

export async function getClient(slug: string) {
  return db.client.findUnique({ where: { slug }, include: { categories: true } });
}
