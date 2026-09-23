import { lstat, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

/**
 * Trim only build-time metadata from the copied migration CLI. Keep executable
 * JavaScript/TypeScript, native engines, WASM, data files and licenses intact.
 * Never follow links into another package store or the source checkout.
 * @param {string} root
 * @returns {Promise<{files: number, bytes: number}>}
 */
export async function pruneMigrationMetadata(root) {
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Migration metadata root must be a real directory: ${root}`);
  }
  const removed = { files: 0, bytes: 0 };
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(target);
      } else if (entry.isFile() && (
        /\.d\.[cm]?ts$/.test(entry.name)
        || /\.(?:[cm]?[jt]s|css)\.map$/.test(entry.name)
      )) {
        const metadata = await lstat(target);
        await rm(target);
        removed.files += 1;
        removed.bytes += metadata.size;
      }
    }
  }
  await visit(root);
  return removed;
}
