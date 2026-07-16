'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/auth/admin';
import { db } from '@/lib/db';
import {
  createDirectoryServer, updateDirectoryServer, deleteDirectoryServer,
  createDirectorySkill, updateDirectorySkill, deleteDirectorySkill,
  setServerRecipe, setServerVerified,
} from '@/lib/admin/market';
import { parseServerRecipe } from '@/lib/workspace/server-recipe';
import { validateServerRecipe } from '@/lib/admin/recipe-validate';
import { fetchGithubSkillBundle } from '@/lib/skills/bundle';
import { syncGithubSkillRegistry } from '@/lib/skills/registry';
import type { AdminActionState } from '@/lib/admin/user-actions';

const SLUG_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
const str = (fd: FormData, k: string) => String(fd.get(k) ?? '').trim();
const nul = (v: string) => (v === '' ? null : v);
const num = (v: string) => { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : 0; };
const ids = (fd: FormData) => fd.getAll('categoryIds').map((v) => String(v));

export type SkillRegistrySyncActionState = {
  error?: string;
  ok?: boolean;
  found?: number;
  created?: number;
  updated?: number;
  failed?: number;
};

export async function createServerAction(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  await requireAdmin();
  const t = await getTranslations('admin');
  const slug = str(fd, 'slug').toLowerCase();
  const name = str(fd, 'name');
  if (!name || !SLUG_RE.test(slug)) return { error: t('errorNameSlugRequired') };
  try {
    await createDirectoryServer({
      slug, name, author: nul(str(fd, 'author')), description: nul(str(fd, 'description')),
      iconUrl: nul(str(fd, 'iconUrl')), stars: num(str(fd, 'stars')),
      isOfficial: fd.get('isOfficial') === 'on', isFeatured: fd.get('isFeatured') === 'on', categoryIds: ids(fd),
    });
  } catch {
    return { error: t('errorServerExists') };
  }
  revalidatePath('/admin/servers');
  redirect('/admin/servers');
}

export async function updateServerAction(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  await requireAdmin();
  const t = await getTranslations('admin');
  const id = str(fd, 'id');
  const name = str(fd, 'name');
  if (!name) return { error: t('errorNameRequired') };
  try {
    await updateDirectoryServer(id, {
      name, author: nul(str(fd, 'author')), description: nul(str(fd, 'description')),
      iconUrl: nul(str(fd, 'iconUrl')), stars: num(str(fd, 'stars')),
      isOfficial: fd.get('isOfficial') === 'on', isFeatured: fd.get('isFeatured') === 'on', categoryIds: ids(fd),
    });
  } catch {
    return { error: t('errorActionFailed') };
  }
  revalidatePath('/admin/servers');
  revalidatePath(`/admin/servers/${id}/edit`);
  return {};
}

export async function deleteServerAction(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  await requireAdmin();
  const t = await getTranslations('admin');
  try {
    await deleteDirectoryServer(str(fd, 'id'));
  } catch (e) {
    const count = e instanceof Error ? /^(?:Refused: )?(\d+) live deployment/.exec(e.message)?.[1] : undefined;
    return { error: count ? t('errorServerReferenced', { count: Number(count) }) : t('errorActionFailed') };
  }
  revalidatePath('/admin/servers');
  redirect('/admin/servers');
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export async function importSkillFromGithubAction(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  await requireAdmin();
  const t = await getTranslations('admin');
  const source = str(fd, 'githubSource').trim();
  if (!source) return { error: t('errorGithubSourceRequired') };

  let bundle;
  try {
    bundle = await fetchGithubSkillBundle(source);
  } catch (e) {
    return { error: t('errorGithubFetch', { message: e instanceof Error ? e.message : t('errorActionFailed') }) };
  }

  const name = bundle.name;
  const description = bundle.description;
  const author = bundle.author;

  let slug = slugify(bundle.slugHint);
  if (!SLUG_RE.test(slug)) slug = slugify(`${bundle.source.owner}-${bundle.source.repo}`);

  const existing = await db.skill.findUnique({ where: { slug } });
  if (existing?.githubSource === bundle.source.normalized) return { error: t('errorAlreadyImported', { slug }) };
  if (existing) slug = `${slug}-${Date.now().toString(36)}`;

  try {
    await createDirectorySkill({
      slug,
      name,
      author,
      description,
      iconUrl: null,
      githubSource: bundle.source.normalized,
      content: bundle.content,
      ...(bundle.files.length ? { files: bundle.files } : {}),
      score: 0,
      categoryIds: [],
    });
  } catch {
    return { error: t('errorSkillCreate') };
  }

  revalidatePath('/admin/skills');
  redirect('/admin/skills');
}

export async function syncSkillRegistryAction(
  _prev: SkillRegistrySyncActionState,
  fd: FormData,
): Promise<SkillRegistrySyncActionState> {
  await requireAdmin();
  const t = await getTranslations('admin');
  const owner = str(fd, 'owner');
  const repo = str(fd, 'repo');
  const ref = str(fd, 'ref') || 'main';
  const rootPath = str(fd, 'rootPath') || 'skills';
  const slugPrefix = str(fd, 'slugPrefix');
  if (!owner || !repo) return { error: t('errorOwnerRepoRequired') };

  try {
    const result = await syncGithubSkillRegistry(db, { owner, repo, ref, rootPath, slugPrefix });
    revalidatePath('/admin/skills');
    revalidatePath('/tools/skills');
    return {
      ok: true,
      found: result.found,
      created: result.created,
      updated: result.updated,
      failed: result.failed.length,
      error: result.failed.length > 0 ? t('errorSyncPartial', { count: result.failed.length }) : undefined,
    };
  } catch (e) {
    return { error: t('errorSyncFailed', { message: e instanceof Error ? e.message : t('errorActionFailed') }) };
  }
}

export async function createSkillAction(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  await requireAdmin();
  const t = await getTranslations('admin');
  const slug = str(fd, 'slug').toLowerCase();
  const name = str(fd, 'name');
  if (!name || !SLUG_RE.test(slug)) return { error: t('errorNameSlugRequired') };
  try {
    await createDirectorySkill({
      slug, name, author: nul(str(fd, 'author')), description: nul(str(fd, 'description')),
      iconUrl: nul(str(fd, 'iconUrl')), githubSource: nul(str(fd, 'githubSource')),
      score: num(str(fd, 'score')), categoryIds: ids(fd),
    });
  } catch {
    return { error: t('errorSkillExists') };
  }
  revalidatePath('/admin/skills');
  redirect('/admin/skills');
}

export async function updateSkillAction(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  await requireAdmin();
  const t = await getTranslations('admin');
  const id = str(fd, 'id');
  const name = str(fd, 'name');
  if (!name) return { error: t('errorNameRequired') };
  try {
    await updateDirectorySkill(id, {
      name, author: nul(str(fd, 'author')), description: nul(str(fd, 'description')),
      iconUrl: nul(str(fd, 'iconUrl')), githubSource: nul(str(fd, 'githubSource')),
      score: num(str(fd, 'score')), categoryIds: ids(fd),
    });
  } catch {
    return { error: t('errorActionFailed') };
  }
  revalidatePath('/admin/skills');
  revalidatePath(`/admin/skills/${id}/edit`);
  return {};
}

export async function deleteSkillAction(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  await requireAdmin();
  const t = await getTranslations('admin');
  try {
    await deleteDirectorySkill(str(fd, 'id'));
  } catch (e) {
    const count = e instanceof Error ? /^(?:Refused: )?(\d+) workspace install/.exec(e.message)?.[1] : undefined;
    return { error: count ? t('errorSkillInstalled', { count: Number(count) }) : t('errorActionFailed') };
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
    envValues: envPairs(str(fd, 'recipeEnvValues')),
    network: fd.get('recipeNetwork') === 'on' ? 'none' : undefined,
  });
}

export async function setServerRecipeAction(_prev: RecipeActionState, fd: FormData): Promise<RecipeActionState> {
  await requireAdmin();
  const t = await getTranslations('admin');
  const id = str(fd, 'id');
  const recipe = recipeFromForm(fd);
  if (!recipe) return { error: t('errorInvalidRecipe') };
  try {
    await setServerRecipe(id, recipe);
  } catch {
    return { error: t('errorActionFailed') };
  }
  revalidatePath(`/admin/servers/${id}/edit`);
  revalidatePath('/admin/servers');
  return { ok: true };
}

export async function removeServerRecipeAction(_prev: RecipeActionState, fd: FormData): Promise<RecipeActionState> {
  await requireAdmin();
  const t = await getTranslations('admin');
  const id = str(fd, 'id');
  try {
    await setServerRecipe(id, null);
  } catch {
    return { error: t('errorActionFailed') };
  }
  revalidatePath(`/admin/servers/${id}/edit`);
  revalidatePath('/admin/servers');
  return { ok: true };
}

export async function validateServerRecipeAction(_prev: RecipeActionState, fd: FormData): Promise<RecipeActionState> {
  await requireAdmin();
  const t = await getTranslations('admin');
  const id = str(fd, 'id');
  const server = await db.server.findUnique({ where: { id }, select: { installCfg: true } });
  const recipe = parseServerRecipe(server?.installCfg);
  if (!recipe) return { error: t('errorSaveRecipeFirst') };

  const result = await validateServerRecipe(recipe, envPairs(str(fd, 'testEnv')));
  if (!result.ok) return { error: t('errorValidationFailed', { message: result.error }) };

  await setServerVerified(id, result.toolCount);
  revalidatePath(`/admin/servers/${id}/edit`);
  revalidatePath('/admin/servers');
  return { ok: true, toolCount: result.toolCount, tools: result.tools };
}
