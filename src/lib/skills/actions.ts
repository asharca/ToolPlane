'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getWorkspaceForUser } from '@/lib/workspace/queries';
import { parseCreateSkill, isGithubUrl, githubRawSkillUrl, slugify } from './custom-skill';

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
    data: { workspaceId: ctx.ws.id, skillId: null, source: 'custom', name: parsed.name, slug: parsed.slug, description: parsed.description || null, content: STARTER, status: 'draft' },
  });
  redirect(`/app/${slug}/skills/${created.id}`);
}

export async function updateSkillContentAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const installId = String(formData.get('installId') ?? '');
  const ctx = await authedWs(slug);
  if (!ctx || !(await ownCustomSkill(installId, ctx.ws.id))) return;
  await db.installedSkill.update({ where: { id: installId }, data: { content: String(formData.get('content') ?? '') } });
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
  } = {
    userInvocable: formData.get('userInvocable') === 'on',
    agentInvocable: formData.get('agentInvocable') === 'on',
    effort: String(formData.get('effort') ?? 'default'),
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

export async function publishSkillAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const installId = String(formData.get('installId') ?? '');
  const ctx = await authedWs(slug);
  if (!ctx) return;
  const s = await ownCustomSkill(installId, ctx.ws.id);
  if (!s) return;
  await db.installedSkill.update({ where: { id: installId }, data: { status: s.status === 'published' ? 'draft' : 'published' } });
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
    data: { workspaceId: ctx.ws.id, skillId: null, source: 'github', sourceRef: repo, name, slug: slugify(name), content, status: 'draft' },
  });
  redirect(`/app/${slug}/skills/${created.id}`);
}

export async function uploadSkillFolderAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const name = String(formData.get('name') ?? '').trim();
  const ctx = await authedWs(slug);
  if (!ctx) return;
  let files: { path: string; content: string }[] = [];
  try {
    files = JSON.parse(String(formData.get('files') ?? '[]'));
  } catch {
    return;
  }
  if (!Array.isArray(files) || files.length === 0 || files.length > 20) return;
  if (!files.every((f) => f && typeof f.path === 'string' && typeof f.content === 'string')) return;
  const skillMd = files.find((f) => /(^|\/)SKILL\.md$/i.test(f.path));
  const extra = files.filter((f) => f !== skillMd).slice(0, 19).map((f) => ({ path: f.path, content: f.content.slice(0, 256_000) }));
  const nm = name || 'Uploaded skill';
  const created = await db.installedSkill.create({
    data: { workspaceId: ctx.ws.id, skillId: null, source: 'upload', name: nm, slug: slugify(nm), content: (skillMd?.content ?? '').slice(0, 256_000), files: extra.length ? extra : undefined, status: 'draft' },
  });
  redirect(`/app/${slug}/skills/${created.id}`);
}
