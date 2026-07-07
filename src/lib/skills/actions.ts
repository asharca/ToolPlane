'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getWorkspaceForUser } from '@/lib/workspace/queries';
import { parseCreateSkill, isGithubUrl, githubRawSkillUrl, slugify } from './custom-skill';
import {
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_IMPORT_BYTES,
  MAX_SKILL_IMPORT_FILES,
  isTextSkillFile,
  parseUploadedSkillBundles,
  type SkillBundleFile,
} from './bundle';

const STARTER = `## What this skill does

Describe the capability.

## How to use it

Describe how an agent should invoke this skill.
`;

async function authedWs(slug: string) {
  const user = await getCurrentUser();
  if (!user) return null;
  const ws = await getWorkspaceForUser(slug, user.id);
  return ws ? { user, ws } : null;
}

async function ownCustomSkill(installId: string, workspaceId: string) {
  return db.installedSkill.findFirst({ where: { id: installId, workspaceId, skillId: null } });
}

function isUploadedFile(value: FormDataEntryValue): value is File {
  return (
    typeof value === 'object' &&
    value !== null &&
    'arrayBuffer' in value &&
    'name' in value &&
    'size' in value
  );
}

function parseFilePathList(raw: FormDataEntryValue | null): string[] {
  try {
    const parsed = JSON.parse(String(raw ?? '[]'));
    return Array.isArray(parsed) ? parsed.map((value) => String(value ?? '')) : [];
  } catch {
    return [];
  }
}

async function readUploadedSkillFiles(formData: FormData): Promise<SkillBundleFile[]> {
  const multipartFiles = formData.getAll('folderFiles').filter(isUploadedFile);
  if (multipartFiles.length > 0) {
    if (multipartFiles.length > MAX_SKILL_IMPORT_FILES) {
      throw new Error(`Skill import has too many files; max ${MAX_SKILL_IMPORT_FILES}.`);
    }

    const paths = parseFilePathList(formData.get('filePaths'));
    let totalBytes = 0;
    const files: SkillBundleFile[] = [];
    for (const [index, file] of multipartFiles.entries()) {
      const path = paths[index] || file.name;
      if (file.size > MAX_SKILL_FILE_BYTES) throw new Error(`File too large: ${path}`);
      totalBytes += file.size;
      if (totalBytes > MAX_SKILL_IMPORT_BYTES) throw new Error('Skill import is too large.');

      const buffer = Buffer.from(await file.arrayBuffer());
      if (isTextSkillFile(path, file.type)) {
        files.push({ path, content: buffer.toString('utf8') });
      } else {
        files.push({ path, content: buffer.toString('base64'), encoding: 'base64' });
      }
    }
    return files;
  }

  const legacy = JSON.parse(String(formData.get('files') ?? '[]'));
  if (!Array.isArray(legacy)) throw new Error('Invalid files payload.');
  return legacy.map((file) => ({
    path: String(file?.path ?? ''),
    content: String(file?.content ?? ''),
    ...(file?.encoding === 'base64' ? { encoding: 'base64' as const } : {}),
  }));
}

function uniqueSkillSlug(name: string, used: Set<string>): string {
  const base = slugify(name);
  let candidate = base;
  for (let i = 2; used.has(candidate); i += 1) {
    candidate = `${base}-${i}`;
  }
  used.add(candidate);
  return candidate;
}

export async function createCustomSkillAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const ctx = await authedWs(slug);
  if (!ctx) return;
  let parsed;
  try {
    parsed = parseCreateSkill({ name: formData.get('name'), description: formData.get('description') ?? '' });
  } catch {
    return;
  }
  const created = await db.installedSkill.create({
    data: { workspaceId: ctx.ws.id, skillId: null, source: 'custom', name: parsed.name, slug: parsed.slug, description: parsed.description || null, content: STARTER, status: 'published' },
  });
  redirect(`/app/${slug}/skills/${created.id}`);
}

export async function updateSkillContentAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const installId = String(formData.get('installId') ?? '');
  const ctx = await authedWs(slug);
  if (!ctx || !(await ownCustomSkill(installId, ctx.ws.id))) return;
  await db.installedSkill.update({ where: { id: installId }, data: { content: String(formData.get('content') ?? ''), status: 'published' } });
  revalidatePath(`/app/${slug}/skills/${installId}`);
}

export async function updateSkillAttributesAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const installId = String(formData.get('installId') ?? '');
  const ctx = await authedWs(slug);
  if (!ctx || !(await ownCustomSkill(installId, ctx.ws.id))) return;
  const data: {
    description?: string | null;
    userInvocable: boolean;
    agentInvocable: boolean;
    effort: string;
    status: string;
  } = {
    userInvocable: formData.get('userInvocable') === 'on',
    agentInvocable: formData.get('agentInvocable') === 'on',
    effort: String(formData.get('effort') ?? 'default'),
    status: 'published',
  };
  if (formData.has('description')) {
    data.description = String(formData.get('description') ?? '') || null;
  }
  await db.installedSkill.update({
    where: { id: installId },
    data,
  });
  revalidatePath(`/app/${slug}/skills/${installId}`);
}

export async function deleteCustomSkillAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const installId = String(formData.get('installId') ?? '');
  const ctx = await authedWs(slug);
  if (!ctx || !(await ownCustomSkill(installId, ctx.ws.id))) return;
  await db.installedSkill.deleteMany({ where: { id: installId, workspaceId: ctx.ws.id } });
  redirect(`/app/${slug}/skills`);
}

export async function importSkillFromGithubAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const repo = String(formData.get('repo') ?? '').trim();
  const ctx = await authedWs(slug);
  if (!ctx || !isGithubUrl(repo)) return;
  let content = '';
  try {
    const res = await fetch(githubRawSkillUrl(repo), { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return;
    content = (await res.text()).slice(0, 200_000);
  } catch {
    return;
  }
  const name = repo.replace(/\/$/, '').split('/').pop() || 'skill';
  const created = await db.installedSkill.create({
    data: { workspaceId: ctx.ws.id, skillId: null, source: 'github', sourceRef: repo, name, slug: slugify(name), content, status: 'published' },
  });
  redirect(`/app/${slug}/skills/${created.id}`);
}

export async function uploadSkillFolderAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const name = String(formData.get('name') ?? '').trim();
  const ctx = await authedWs(slug);
  if (!ctx) return;
  let bundles;
  try {
    const files = await readUploadedSkillFiles(formData);
    bundles = parseUploadedSkillBundles(files, name);
  } catch {
    return;
  }
  const existing = await db.installedSkill.findMany({
    where: { workspaceId: ctx.ws.id },
    select: { slug: true, skill: { select: { slug: true } } },
  });
  const usedSlugs = new Set(
    existing
      .map((skill) => skill.slug || skill.skill?.slug || null)
      .filter((value): value is string => Boolean(value)),
  );

  const created = await db.$transaction(
    bundles.map((bundle) => {
      const nm = bundles.length === 1 && name ? name : bundle.name;
      return db.installedSkill.create({
        data: {
          workspaceId: ctx.ws.id,
          skillId: null,
          source: 'upload',
          sourceRef: bundle.rootPath,
          name: nm,
          slug: uniqueSkillSlug(nm, usedSlugs),
          description: bundle.description,
          content: bundle.content,
          files: bundle.files.length ? bundle.files : undefined,
          status: 'published',
        },
      });
    }),
  );
  revalidatePath(`/app/${slug}/skills`);
  redirect(`/app/${slug}/skills?imported=${encodeURIComponent(created.map((skill) => skill.id).join(','))}`);
}
