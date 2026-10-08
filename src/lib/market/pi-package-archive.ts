import 'server-only';
import { gzipSync } from 'node:zlib';
import { db } from '@/lib/db';
import { parsePiPackageReleaseManifest, scanPiPackageReleaseManifest } from '@/lib/market/pi-package-manifest';
import type { PiPackageManifestV1 } from '@/lib/market/pi-package-manifest';

/** Deterministic POSIX tar + gzip. PAX records preserve long UTF-8 paths and link targets. */
export function serializePiPackageArchive(manifest: PiPackageManifestV1): Buffer {
  const snapshot = parsePiPackageReleaseManifest(manifest).package;
  const chunks: Buffer[] = [];
  function append(name: string, type: string, bytes: Buffer, mode: number, link = '') {
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, 'utf8');
    header.write(`${mode.toString(8).padStart(7, '0')}\0`, 100, 8, 'ascii');
    header.write('0000000\0', 108, 8, 'ascii');
    header.write('0000000\0', 116, 8, 'ascii');
    header.write(`${bytes.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
    header.write('00000000000\0', 136, 12, 'ascii');
    header.fill(32, 148, 156);
    header.write(type, 156, 1, 'ascii');
    header.write(link, 157, 100, 'utf8');
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    chunks.push(header);
    if (bytes.length) chunks.push(bytes);
    const padding = (512 - bytes.length % 512) % 512;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  const entries = [...snapshot.entries].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  let index = 0;
  for (const entry of entries) {
    let path = entry.type === 'directory' ? `${entry.path}/` : entry.path;
    const link = entry.type === 'symlink' ? entry.target : '';
    const attributes: Array<[string, string]> = [];
    if (Buffer.byteLength(path) > 100) attributes.push(['path', path]);
    if (Buffer.byteLength(link) > 100) attributes.push(['linkpath', link]);
    if (attributes.length) {
      const records = attributes.map(([key, value]) => {
        const body = ` ${key}=${value}\n`;
        let length = Buffer.byteLength(body) + 1;
        while (length !== Buffer.byteLength(body) + String(length).length) length = Buffer.byteLength(body) + String(length).length;
        return `${length}${body}`;
      }).join('');
      append(`PaxHeaders/${index}`, 'x', Buffer.from(records), 0o644);
      if (Buffer.byteLength(path) > 100) path = `package/.pax-${index}`;
      // Retain the legacy linkname prefix: older libarchive uses its presence to
      // distinguish symlinks from hardlinks when applying the PAX linkpath.
    }
    append(path, entry.type === 'directory' ? '5' : entry.type === 'symlink' ? '2' : '0', entry.type === 'file' ? Buffer.from(entry.content, 'base64') : Buffer.alloc(0), entry.type === 'directory' || entry.type === 'file' && entry.executable ? 0o755 : 0o644, link);
    index += 1;
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks), { level: 9 });
}

export async function getPiPackageDownload(input: { workspaceId: string; userId: string; releaseId: string }): Promise<{ archive: Buffer; filename: string; checksum: string }> {
  return db.$transaction(async (tx) => {
    const workspace = await tx.workspace.findFirst({ where: { id: input.workspaceId, status: 'active', OR: [{ ownerId: input.userId }, { members: { some: { userId: input.userId } } }] }, select: { id: true } });
    const user = await tx.user.findFirst({ where: { id: input.userId, status: 'active' }, select: { id: true } });
    if (!workspace || !user) throw new Error('not_authorized');
    const release = await tx.marketRelease.findFirst({ where: { id: input.releaseId, reviewStatus: 'approved', listing: { kind: 'pi-package', status: 'published', OR: [{ visibility: 'public' }, { visibility: 'private', publisherWorkspaceId: workspace.id }] } }, include: { listing: { select: { latestReleaseId: true, slug: true } } } });
    if (!release) throw new Error('listing_unavailable');
    if (release.listing.latestReleaseId !== release.id) {
      const install = await tx.marketInstall.findFirst({ where: { targetWorkspaceId: workspace.id, listingId: release.listingId, status: 'ready', OR: [{ currentReleaseId: release.id }, { agentPiPackages: { some: { releaseId: release.id } } }, { piPackageClientInstallations: { some: { releaseId: release.id, status: 'active', userId: input.userId } } }] }, select: { id: true } });
      if (!install) throw new Error('listing_unavailable');
    }
    const manifest = parsePiPackageReleaseManifest(release.manifest, release.checksum);
    if (scanPiPackageReleaseManifest(manifest, release.releaseNotes).status === 'blocked') throw new Error('pi_package_invalid');
    return { archive: serializePiPackageArchive(manifest), filename: `${release.listing.slug}-${release.version}.tgz`, checksum: release.checksum };
  }, { isolationLevel: 'Serializable', timeout: 30_000 });
}
