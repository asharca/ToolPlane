// React multipart encoding renames unnamed native file placeholders to "blob".
// Remove them before encoding, while real named zero-byte assets remain distinguishable.
export function normalizeSkillUploadForm(data: FormData): FormData {
  for (const name of ["archive", "folderFiles"]) {
    if (
      data
        .getAll(name)
        .every(
          (value) =>
            typeof value !== "string" && value.name === "" && value.size === 0,
        )
    )
      data.delete(name);
  }
  return data;
}
