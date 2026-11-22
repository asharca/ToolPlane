export function attachedFileText(
  filename: string,
  runtimePath: string,
): string {
  return `[Attached file: ${filename.replace(/\s+/g, " ").slice(0, 240)} at ${runtimePath.replace(/\s+/g, " ").slice(0, 1_000)}]`;
}
