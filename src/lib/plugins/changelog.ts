import type {
  PiPackageEntryV1,
  PiPackageSnapshotV1,
} from "@/lib/pi-packages/manifest";

export type PluginChangelog = {
  text: string;
  sourceUrl: string | null;
  kind: "release-notes" | "changelog";
};

const MAX_CHANGELOG_BYTES = 256 * 1024;
// Stable precedence, independent of archive/tree order; only package-root files.
const CHANGELOG_NAMES = [
  "changelog.md",
  "changelog.markdown",
  "changelog.txt",
  "changelog",
  "history.md",
  "history.markdown",
  "history.txt",
  "history",
];

function changelogFile(entries: PiPackageEntryV1[]) {
  let selected: Extract<PiPackageEntryV1, { type: "file" }> | undefined;
  let rank = CHANGELOG_NAMES.length;
  for (const entry of entries) {
    if (entry.type !== "file" || !entry.path.startsWith("package/")) continue;
    const candidate = CHANGELOG_NAMES.indexOf(
      entry.path.slice("package/".length).toLowerCase(),
    );
    if (
      candidate >= 0 &&
      (candidate < rank ||
        (candidate === rank && selected && entry.path < selected.path))
    ) {
      selected = entry;
      rank = candidate;
    }
  }
  return selected;
}

function displayableText(text: string) {
  // Keep tabs and line endings, but reject binary/control payloads.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject non-text document bytes.
  return !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(text);
}

function decodeChangelog(entry: Extract<PiPackageEntryV1, { type: "file" }>) {
  if (Buffer.byteLength(entry.content, "base64") > MAX_CHANGELOG_BYTES)
    return null;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.from(entry.content, "base64"),
    );
    return text.trim() && displayableText(text) ? text : null;
  } catch {
    return null;
  }
}

/** ATX version sections only: never infer a version from surrounding prose. */
function versionNotes(text: string, version: string | null): string | null {
  if (!version) return null;
  let fence: { marker: string; length: number } | null = null;
  let htmlEnd: RegExp | null = null;
  let start: number | null = null;
  let level = 0;
  for (const line of text.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/g)) {
    const content = line[0].replace(/[\r\n]+$/, "");
    if (htmlEnd) {
      if (htmlEnd.test(content)) htmlEnd = null;
      continue;
    }
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(content);
    if (fence) {
      if (
        delimiter &&
        delimiter[1][0] === fence.marker &&
        delimiter[1].length >= fence.length &&
        !delimiter[2].trim()
      )
        fence = null;
      continue;
    }
    if (delimiter) {
      fence = { marker: delimiter[1][0], length: delimiter[1].length };
      continue;
    }
    const htmlCode = /^ {0,3}<(pre|script|style|textarea)(?:[\t >])/i.exec(
      content,
    );
    if (htmlCode || /^ {0,3}<!--/.test(content)) {
      const end = htmlCode ? new RegExp(`</${htmlCode[1]}\\s*>`, "i") : /-->/;
      if (!end.test(content)) htmlEnd = end;
      continue;
    }
    const heading = /^ {0,3}(#{1,6})[\t ]+(.+?)\s*$/.exec(content);
    if (!heading) continue;
    if (start !== null && heading[1].length <= level)
      return text.slice(start, line.index).trim() || null;
    if (start !== null) continue;
    const title = heading[2].replace(/[\t ]+#+[\t ]*$/, "").trim();
    // An exact version token, optionally linked/bracketed/prefixed with v and
    // followed by a date or dash-delimited title; never a semver prefix match.
    const label =
      /^(?:\[v?([^\]]+)\](?:\([^)]*\))?|v?([^\s]+))(?:[\t ]+(?:[-–—][\t ]+.+|\d{4}-\d{2}-\d{2}))?$/.exec(
        title,
      );
    if (label && (label[1] ?? label[2]) === version) {
      start = line.index + line[0].length;
      level = heading[1].length;
    }
  }
  return start === null ? null : text.slice(start).trim() || null;
}

function githubSourceUrl(snapshot: PiPackageSnapshotV1, path: string) {
  const source = snapshot.source;
  if (
    source.kind !== "git" ||
    !/^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(
      source.url,
    ) ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(source.commit)
  )
    return null;
  const repository = source.url.replace(/\.git$/, "");
  if ([".", ".."].includes(repository.split("/").at(-1) ?? "")) return null;
  const parts = [
    ...(source.path?.split("/") ?? []),
    path.slice("package/".length),
  ];
  if (
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject unsafe provenance paths.
        /[\\\x00-\x1f\x7f]/.test(part),
    )
  )
    return null;
  return `${repository}/blob/${source.commit}/${parts.map(encodeURIComponent).join("/")}`;
}

/** Accept only an already parsed/validated immutable package snapshot. */
export function readPluginChangelog(
  snapshot: PiPackageSnapshotV1,
  releaseNotes?: string | null,
): PluginChangelog | null {
  const storedNotes = releaseNotes?.trim() ? releaseNotes : null;
  const file = changelogFile(snapshot.entries);
  const text = file ? decodeChangelog(file) : null;
  const notes = text ? versionNotes(text, snapshot.version) : null;
  const sourceUrl = file && text ? githubSourceUrl(snapshot, file.path) : null;
  if (storedNotes)
    return {
      text: storedNotes,
      sourceUrl: notes === storedNotes ? sourceUrl : null,
      kind: "release-notes",
    };
  if (!text) return null;
  return notes
    ? { text: notes, sourceUrl, kind: "release-notes" }
    : { text, sourceUrl, kind: "changelog" };
}
