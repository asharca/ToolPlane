import { readFile } from "node:fs/promises";
import path from "node:path";
export const runtime = "nodejs";
export async function GET() {
  const source = await readFile(
    path.join(process.cwd(), "scripts/pi-package-install.mjs"),
    "utf8",
  );
  return new Response(source, {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "content-disposition": 'attachment; filename="pi-package-install.mjs"',
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    },
  });
}
