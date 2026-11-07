import "server-only";
import type { PiPackageSnapshotV1 } from "@/lib/pi-packages/manifest";

export const RESOURCE_PREVIEW_MAX_BYTES = 262_144;

/** Only accepts a verified release snapshot obtained through workspace-authorized getPlugin. */
export function previewPluginResource(
  snapshot: PiPackageSnapshotV1,
  path: string,
) {
  const kind = Object.entries(snapshot.resources).find(([, paths]) =>
    paths?.includes(path),
  )?.[0];
  if (
    !kind ||
    !path.startsWith("package/") ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject control bytes in untrusted snapshot paths.
    /[\\\x00-\x1f\x7f]/.test(path) ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  )
    return { status: "notAllowed" as const };
  const entry = snapshot.entries.find((candidate) => candidate.path === path);
  if (!entry) return { status: "missing" as const, kind };
  const parts = path.split("/");
  if (
    snapshot.entries.some(
      (candidate) =>
        candidate.type === "symlink" &&
        parts.some(
          (_, index) => parts.slice(0, index + 1).join("/") === candidate.path,
        ),
    )
  )
    return { status: "symlink" as const, kind };
  if (entry.type !== "file") return { status: "notFile" as const, kind };
  const size = Buffer.byteLength(entry.content, "base64");
  if (size > RESOURCE_PREVIEW_MAX_BYTES)
    return { status: "tooLarge" as const, kind, size };
  const bytes = Buffer.from(entry.content, "base64");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { status: "invalidUtf8" as const, kind, size };
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject binary control bytes while retaining text whitespace.
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text))
    return { status: "binary" as const, kind, size };
  if (!text.trim()) return { status: "empty" as const, kind, size };
  return {
    status: "ready" as const,
    kind,
    size,
    text,
    markdown: /\.(md|markdown)$/i.test(path),
  };
}
