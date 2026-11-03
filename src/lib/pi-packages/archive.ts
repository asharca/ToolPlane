import "server-only";
import { gzipSync } from "node:zlib";
import { parsePiPackageReleaseManifest } from "@/lib/pi-packages/manifest";
import type { PiPackageManifestV1 } from "@/lib/pi-packages/manifest";

/** Deterministic POSIX tar + gzip. PAX records preserve long UTF-8 paths and link targets. */
export function serializePiPackageArchive(
  manifest: PiPackageManifestV1,
): Buffer {
  const snapshot = parsePiPackageReleaseManifest(manifest).package;
  const chunks: Buffer[] = [];
  function append(
    name: string,
    type: string,
    bytes: Buffer,
    mode: number,
    link = "",
  ) {
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, "utf8");
    header.write(`${mode.toString(8).padStart(7, "0")}\0`, 100, 8, "ascii");
    header.write("0000000\0", 108, 8, "ascii");
    header.write("0000000\0", 116, 8, "ascii");
    header.write(
      `${bytes.length.toString(8).padStart(11, "0")}\0`,
      124,
      12,
      "ascii",
    );
    header.write("00000000000\0", 136, 12, "ascii");
    header.fill(32, 148, 156);
    header.write(type, 156, 1, "ascii");
    header.write(link, 157, 100, "utf8");
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.write(
      `${checksum.toString(8).padStart(6, "0")}\0 `,
      148,
      8,
      "ascii",
    );
    chunks.push(header);
    if (bytes.length) chunks.push(bytes);
    const padding = (512 - (bytes.length % 512)) % 512;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  const entries = [...snapshot.entries].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  let index = 0;
  for (const entry of entries) {
    let path = entry.type === "directory" ? `${entry.path}/` : entry.path;
    const link = entry.type === "symlink" ? entry.target : "";
    const attributes: Array<[string, string]> = [];
    if (Buffer.byteLength(path) > 100) attributes.push(["path", path]);
    if (Buffer.byteLength(link) > 100) attributes.push(["linkpath", link]);
    if (attributes.length) {
      const records = attributes
        .map(([key, value]) => {
          const body = ` ${key}=${value}\n`;
          let length = Buffer.byteLength(body) + 1;
          while (length !== Buffer.byteLength(body) + String(length).length)
            length = Buffer.byteLength(body) + String(length).length;
          return `${length}${body}`;
        })
        .join("");
      append(`PaxHeaders/${index}`, "x", Buffer.from(records), 0o644);
      if (Buffer.byteLength(path) > 100) path = `package/.pax-${index}`;
      // Retain the legacy linkname prefix: older libarchive uses its presence to
      // distinguish symlinks from hardlinks when applying the PAX linkpath.
    }
    append(
      path,
      entry.type === "directory" ? "5" : entry.type === "symlink" ? "2" : "0",
      entry.type === "file"
        ? Buffer.from(entry.content, "base64")
        : Buffer.alloc(0),
      entry.type === "directory" || (entry.type === "file" && entry.executable)
        ? 0o755
        : 0o644,
      link,
    );
    index += 1;
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks), { level: 9 });
}
