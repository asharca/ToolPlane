'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { requireAdmin } from '@/lib/auth/admin';
import { db } from '@/lib/db';
import {
  createDirectoryServer, updateDirectoryServer, deleteDirectoryServer,
  createDirectorySkill, updateDirectorySkill, deleteDirectorySkill,
  setServerRecipe, setServerVerified,
} from '@/lib/admin/market';
import { parseServerRecipe } from '@/lib/workspace/server-recipe';
import { validateServerRecipe } from '@/lib/admin/recipe-validate';
import type { AdminActionState } from '@/lib/admin/user-actions';

const SLUG_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
const str = (fd: FormData, k: string) => String(fd.get(k) ?? '').trim();
const nul = (v: string) => (v === '' ? null : v);
const num = (v: string) => { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : 0; };
const ids = (fd: FormData) => fd.getAll('categoryIds').map((v) => String(v));

export async function createServerAction(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  await requireAdmin();
  const slug = str(fd, 'slug').toLowerCase();
  const name = str(fd, 'name');
  if (!name || !SLUG_RE.test(slug)) return { error: 'Name and a valid slug are required.' };
  try {
    await createDirectoryServer({
      slug, name, author: nul(str(fd, 'author')), description: nul(str(fd, 'description')),
      iconUrl: nul(str(fd, 'iconUrl')), stars: num(str(fd, 'stars')),
      isOfficial: fd.get('isOfficial') === 'on', isFeatured: fd.get('isFeatured') === 'on', categoryIds: ids(fd),
    });
  } catch {
    return { error: 'A server with that slug already exists.' };
  }
  revalidatePath('/admin/servers');
  redirect('/admin/servers');
}

export async function updateServerAction(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  await requireAdmin();
  const id = str(fd, 'id');
  const name = str(fd, 'name');
  if (!name) return { error: 'Name is required.' };
  await updateDirectoryServer(id, {
    name, author: nul(str(fd, 'author')), description: nul(str(fd, 'description')),
    iconUrl: nul(str(fd, 'iconUrl')), stars: num(str(fd, 'stars')),
    isOfficial: fd.get('isOfficial') === 'on', isFeatured: fd.get('isFeatured') === 'on', categoryIds: ids(fd),
  });
  revalidatePath('/admin/servers');
  revalidatePath(`/admin/servers/${id}/edit`);
  return {};
}

export async function deleteServerAction(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  await requireAdmin();
  try {
    await deleteDirectoryServer(str(fd, 'id'));
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Failed.' };
  }
  revalidatePath('/admin/servers');
  redirect('/admin/servers');
}

export async function createSkillAction(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  await requireAdmin();
  const slug = str(fd, 'slug').toLowerCase();
  const name = str(fd, 'name');
  if (!name || !SLUG_RE.test(slug)) return { error: 'Name and a valid slug are required.' };
  try {
    await createDirectorySkill({
      slug, name, author: nul(str(fd, 'author')), description: nul(str(fd, 'description')),
      iconUrl: nul(str(fd, 'iconUrl')), score: num(str(fd, 'score')), categoryIds: ids(fd),
    });
  } catch {
    return { error: 'A skill with that slug already exists.' };
  }
  revalidatePath('/admin/skills');
  redirect('/admin/skills');
}

export async function updateSkillAction(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  await requireAdmin();
  const id = str(fd, 'id');
  const name = str(fd, 'name');
  if (!name) return { error: 'Name is required.' };
  await updateDirectorySkill(id, {
    name, author: nul(str(fd, 'author')), description: nul(str(fd, 'description')),
    iconUrl: nul(str(fd, 'iconUrl')), score: num(str(fd, 'score')), categoryIds: ids(fd),
  });
  revalidatePath('/admin/skills');
  revalidatePath(`/admin/skills/${id}/edit`);
  return {};
}

export async function deleteSkillAction(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  await requireAdmin();
  try {
    await deleteDirectorySkill(str(fd, 'id'));
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Failed.' };
  }
  revalidatePath('/admin/skills');
  redirect('/admin/skills');
}

// ---- Server deploy recipes ----

export type RecipeActionState = { error?: string; ok?: boolean; toolCount?: number; tools?: string[] };

const SOURCES = new Set(['npm', 'pypi', 'github', 'docker']);

// Free-form env-keys field → list (comma / whitespace / newline separated).
function envKeys(raw: string): string[] {
  return raw.split(/[\s,]+/).map((k) => k.trim()).filter(Boolean);
}

// "KEY=value" lines → map (throwaway test values used only during validation).
function envPairs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\n+/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function recipeFromForm(fd: FormData) {
  const source = str(fd, 'recipeSource');
  if (!SOURCES.has(source)) return null;
  return parseServerRecipe({
    source,
    ref: str(fd, 'recipeRef'),
    startCommand: str(fd, 'recipeStartCommand'),
    env: envKeys(str(fd, 'recipeEnv')),
    network: fd.get('recipeNetwork') === 'on' ? 'none' : undefined,
  });
}

export async function setServerRecipeAction(_prev: RecipeActionState, fd: FormData): Promise<RecipeActionState> {
  await requireAdmin();
  const id = str(fd, 'id');
  const recipe = recipeFromForm(fd);
  if (!recipe) return { error: 'Invalid recipe: pick a source and a valid package/image reference.' };
  await setServerRecipe(id, recipe);
  revalidatePath(`/admin/servers/${id}/edit`);
  revalidatePath('/admin/servers');
  return {};
}

export async function removeServerRecipeAction(_prev: RecipeActionState, fd: FormData): Promise<RecipeActionState> {
  await requireAdmin();
  const id = str(fd, 'id');
  await setServerRecipe(id, null);
  revalidatePath(`/admin/servers/${id}/edit`);
  revalidatePath('/admin/servers');
  return {};
}

export async function validateServerRecipeAction(_prev: RecipeActionState, fd: FormData): Promise<RecipeActionState> {
  await requireAdmin();
  const id = str(fd, 'id');
  const server = await db.server.findUnique({ where: { id }, select: { installCfg: true } });
  const recipe = parseServerRecipe(server?.installCfg);
  if (!recipe) return { error: 'Save a valid recipe before validating.' };

  const result = await validateServerRecipe(recipe, envPairs(str(fd, 'testEnv')));
  if (!result.ok) return { error: result.error };

  await setServerVerified(id, result.toolCount);
  revalidatePath(`/admin/servers/${id}/edit`);
  revalidatePath('/admin/servers');
  return { ok: true, toolCount: result.toolCount, tools: result.tools };
}
