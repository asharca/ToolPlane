// @vitest-environment node
import { createRequire } from "node:module";
import { expect, it } from "vitest";
import { normalizeSkillUploadForm } from "@/lib/skills/upload-form";

const { encodeReply } = createRequire(import.meta.url)(
  "next/dist/compiled/react-server-dom-turbopack/client.node.js",
) as {
  encodeReply(value: unknown[]): Promise<string | FormData>;
};
async function transmittedFiles(data: FormData) {
  const encoded = await encodeReply([{}, data]);
  const decoded = await new Request("http://toolplane.test/upload", {
    method: "POST",
    body: encoded,
  }).formData();
  return [...decoded.values()]
    .filter((value): value is File => typeof value !== "string")
    .map((file) => ({ name: file.name, size: file.size }));
}
it("removes the unselected folder placeholder before real React and HTTP multipart encoding", async () => {
  const data = new FormData();
  data.set("archive", new File(["owned archive"], "owned.zip"));
  data.set("folderFiles", new File([], ""));
  const normalized = normalizeSkillUploadForm(data);
  expect(normalized.has("folderFiles")).toBe(false);
  expect(await transmittedFiles(normalized)).toEqual([
    { name: "owned.zip", size: 13 },
  ]);
});
it("keeps named zero-byte assets while removing the unselected archive placeholder", async () => {
  const data = new FormData();
  data.set("archive", new File([], ""));
  data.append("folderFiles", new File([], "empty.txt"));
  data.append("folderFiles", new File([], "blob"));
  expect(await transmittedFiles(normalizeSkillUploadForm(data))).toEqual([
    { name: "empty.txt", size: 0 },
    { name: "blob", size: 0 },
  ]);
});
