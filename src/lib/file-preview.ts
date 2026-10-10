export type FilePreviewKind =
  | "text"
  | "markdown"
  | "image"
  | "pdf"
  | "unsupported";

const imageTypes: Record<string, string> = {
  avif: "image/avif",
  bmp: "image/bmp",
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  webp: "image/webp",
};
const textExtensions: Record<string, true> = {
  bash: true,
  c: true,
  cc: true,
  conf: true,
  cpp: true,
  css: true,
  csv: true,
  diff: true,
  env: true,
  go: true,
  h: true,
  hpp: true,
  html: true,
  ini: true,
  java: true,
  js: true,
  json: true,
  jsonl: true,
  jsx: true,
  log: true,
  mjs: true,
  patch: true,
  py: true,
  rs: true,
  scss: true,
  sh: true,
  sql: true,
  toml: true,
  ts: true,
  tsx: true,
  txt: true,
  xml: true,
  yaml: true,
  yml: true,
  zsh: true,
};

/** HTML/MDX are data, never executable documents. Unknown binary formats stay downloads. */
export function previewType(
  name: string,
  mimeType = "",
): { kind: FilePreviewKind; mimeType?: string } {
  const mime = mimeType.split(";")[0].trim().toLowerCase();
  const filename = name.split(/[\\/]/).pop() ?? "";
  const extension = filename.includes(".")
    ? filename.slice(filename.lastIndexOf(".") + 1).toLowerCase()
    : "";
  if (Object.values(imageTypes).includes(mime))
    return { kind: "image", mimeType: mime };
  if (mime === "application/pdf") return { kind: "pdf", mimeType: mime };
  if (extension === "pdf") return { kind: "pdf", mimeType: "application/pdf" };
  if (Object.hasOwn(imageTypes, extension))
    return { kind: "image", mimeType: imageTypes[extension] };
  if (extension === "md" || extension === "mdx" || mime === "text/markdown")
    return { kind: "markdown" };
  if (
    mime.startsWith("text/") ||
    [
      "application/json",
      "application/xml",
      "application/yaml",
      "application/javascript",
    ].includes(mime) ||
    !extension ||
    Object.hasOwn(textExtensions, extension)
  )
    return { kind: "text" };
  return { kind: "unsupported" };
}
