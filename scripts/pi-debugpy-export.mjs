import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

// Executed only inside the fixed offline capture image; never accepts a path.
export async function exportDebugpy() {
  const root = "/opt/toolplane-tools/debugpy";
  const files = [];
  let total = 0;
  async function visit(path) {
    const absolute = join(root, path);
    const info = await lstat(absolute);
    if (info.isDirectory()) {
      for (const name of (await readdir(absolute)).sort()) {
        if (name !== "__pycache__") await visit(`${path}/${name}`);
      }
    } else if (info.isFile()) {
      // Only the portable implementation is needed. The extension explicitly
      // disables optional CPython-minor-specific accelerators.
      if (!/\.(py|json|txt)$/.test(path)) return;
      if (files.length >= 10_000) throw Error("DEBUG_ARTIFACT_LIMIT");
      const bytes = await readFile(absolute);
      total += bytes.length;
      if (total > 64 * 1024 * 1024) throw Error("DEBUG_ARTIFACT_LIMIT");
      files.push({
        path,
        content: bytes.toString("base64"),
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    } else throw Error("DEBUG_ARTIFACT_SCOPE");
  }
  await visit("debugpy");
  const data = gzipSync(JSON.stringify({ version: "1.8.17", files }));
  if (data.length > 8 * 1024 * 1024) throw Error("DEBUG_ARTIFACT_LIMIT");
  return {
    sha256: createHash("sha256").update(data).digest("hex"),
    data: data.toString("base64"),
  };
}
