'use server';

import { revalidatePath } from 'next/cache';
import { getCurrentUser } from '@/lib/auth/current-user';
import { db } from '@/lib/db';
import { getWorkspaceForUser } from '@/lib/workspace/queries';
import { MarketError } from '@/lib/market/skills';
import { installOfficialPiPackage, publishPiPackageRelease } from '@/lib/market/resources';
import {
  checkPiPackageUpdates, createPiPackageSource, deletePiPackageSource,
  ignorePiPackageUpdate, publishPiPackageToRegistry, updatePiPackageSource,
} from '@/lib/market/pi-package-catalog';

export type PiCatalogActionState = { ok?: boolean; error?: string; listingId?: string; installId?: string };

export async function piCatalogAction(_previous: PiCatalogActionState, data: FormData): Promise<PiCatalogActionState> {
  const field = (key: string) => String(data.get(key) ?? '').trim();
  const user = await getCurrentUser();
  const workspace = user ? await getWorkspaceForUser(field('workspace'), user.id) : null;
  if (!user || !workspace) return { error: 'not_authorized' };
  const context = { workspaceId: workspace.id, userId: user.id };
  const operation = field('operation');
  try {
    let listingId: string | undefined;
    let installId: string | undefined;
    if (operation === 'install-official') {
      const result = await installOfficialPiPackage({ ...context, name: field('name'), version: field('version') });
      installId = result.install.id;
    } else if (operation === 'check') {
      await checkPiPackageUpdates({ ...context, ...(field('listingId') ? { listingId: field('listingId') } : {}) });
    } else if (operation === 'ignore') {
      await ignorePiPackageUpdate({ ...context, listingId: field('listingId'), identity: field('identity') });
    } else {
      const membership = workspace.ownerId === user.id ? null : await db.membership.findUnique({
        where: { workspaceId_userId: { workspaceId: workspace.id, userId: user.id } }, select: { role: true },
      });
      if (workspace.ownerId !== user.id && membership?.role !== 'admin') return { error: 'not_authorized' };
      if (operation === 'create-source' || operation === 'update-source') {
        const auth = field('auth');
        const credentials = auth === 'bearer'
          ? { type: 'bearer' as const, token: String(data.get('token') ?? '') }
          : auth === 'basic'
            ? { type: 'basic' as const, username: field('username'), password: String(data.get('password') ?? '') }
            : auth === 'clear' ? null : undefined;
        if (!['keep', 'clear', 'bearer', 'basic'].includes(auth)) return { error: 'invalid_source' };
        if (operation === 'create-source') {
          const kind = field('kind');
          if (kind !== 'catalog' && kind !== 'npm' && kind !== 'git') return { error: 'invalid_source' };
          await createPiPackageSource({ ...context, name: field('name'), kind, url: field('url'), credentials: credentials ?? undefined });
        } else {
          await updatePiPackageSource({ ...context, sourceId: field('sourceId'), name: field('name'), url: field('url'), credentials });
        }
      } else if (operation === 'delete-source') {
        if (field('confirm') !== 'on') return { error: 'confirmation_required' };
        await deletePiPackageSource({ ...context, sourceId: field('sourceId') });
      } else if (operation === 'registry-publish') {
        if (field('confirm') !== 'on') return { error: 'confirmation_required' };
        await publishPiPackageToRegistry({ ...context, sourceId: field('sourceId'), releaseId: field('releaseId'), tag: field('tag') || undefined, confirm: true });
      } else if (operation === 'import' || operation === 'capture') {
        let source = field('source');
        let sourceId = field('sourceId') || undefined;
        let listing = { name: field('name'), slug: field('slug'), summary: field('summary'), tags: [] as string[] };
        let categoryIds = data.getAll('categoryIds').map(String);
        let visibility: 'private' | 'public' = 'private';
        if (operation === 'capture') {
          const existing = await db.marketListing.findFirst({
            where: { id: field('listingId'), publisherWorkspaceId: workspace.id, kind: 'pi-package' },
            select: { id: true, name: true, slug: true, summary: true, tags: true, visibility: true, categories: { select: { id: true } } },
          });
          const tracking = existing ? await db.piPackageTracking.findFirst({
            where: { listingId: existing.id, workspaceId: workspace.id }, select: { requested: true, sourceId: true },
          }) : null;
          if (!existing || !tracking) return { error: 'source_not_found' };
          listingId = existing.id;
          source = tracking.requested;
          sourceId = tracking.sourceId ?? undefined;
          listing = { name: existing.name, slug: existing.slug, summary: existing.summary ?? '', tags: existing.tags };
          categoryIds = existing.categories.map((category) => category.id);
          visibility = existing.visibility === 'public' ? 'public' : 'private';
        }
        const result = await publishPiPackageRelease({
          workspaceId: workspace.id, publishedById: user.id, source, sourceId, listingId, visibility,
          listing, categoryIds,
        });
        listingId = result.listing.id;
      } else return { error: 'action_failed' };
    }
    revalidatePath(`/app/${workspace.slug}/market/pi-packages`);
    revalidatePath(`/app/${workspace.slug}/toolkits/pi-packages`);
    revalidatePath(`/app/${workspace.slug}/toolkits/pi-packages/sources`);
    revalidatePath(`/app/${workspace.slug}/market/installed`);
    return { ok: true, listingId, installId };
  } catch (error) {
    // Only bounded machine codes cross the action boundary; never upstream response bodies or URLs.
    const code = error instanceof MarketError ? error.code : '';
    return { error: /^[a-z][a-z0-9_]{0,79}$/.test(code) ? code : 'action_failed' };
  }
}
