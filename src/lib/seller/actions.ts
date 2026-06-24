'use server';

import { revalidatePath } from 'next/cache';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth/current-user';

function slugify(input: string): string {
  const base = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || 'skill';
}

// Seller flow: publish a new agent skill to the directory. Creates a real
// Skill row authored by the current user.
export async function submitSkillAction(formData: FormData) {
  const workspace = String(formData.get('workspace') ?? '');
  const name = String(formData.get('name') ?? '').trim();
  const description = String(formData.get('description') ?? '').trim();
  const categoryId = String(formData.get('categoryId') ?? '');
  if (!workspace || !name) return;

  const user = await getCurrentUser();
  if (!user) return;

  const base = slugify(name);
  let slug = base;
  for (let i = 1; await db.skill.findUnique({ where: { slug } }); i += 1) {
    slug = `${base}-${i}`;
  }

  await db.skill.create({
    data: {
      slug,
      name,
      description: description || null,
      author: user.email,
      score: 0,
      ...(categoryId
        ? { categories: { connect: { id: categoryId } } }
        : {}),
    },
  });

  revalidatePath(`/app/${workspace}/seller`);
}
