import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readZip, writeZip } from "@/lib/archives/zip";
import { parseUploadedSkillBundles } from "@/lib/skills/bundle";

const limits = {
  maxBytes: 1024,
  maxArchiveBytes: 4096,
  maxFileBytes: 512,
  maxFiles: 10,
};
describe("portable skill ZIP", () => {
  it.each(["seek", "stream"])(
    "interoperates with Python stored/deflate ZIPs (%s)",
    (mode) => {
      const producer = String.raw`
import io, sys, zipfile
class Streaming(io.BytesIO):
    def seekable(self): return False
    def seek(self, *args): raise io.UnsupportedOperation()
out = Streaming() if sys.argv[1] == "stream" else io.BytesIO()
with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED) as z:
    z.writestr("first/", b"", compress_type=zipfile.ZIP_DEFLATED)
    z.writestr("first/SKILL.md", "---\nname: first\ndescription: Smoke\n---\n# First")
    z.writestr("first/images/图标.bin", bytes([0, 255, 128]), compress_type=zipfile.ZIP_STORED)
    z.writestr("second/SKILL.md", "# Second")
assert z.getinfo("first/").file_size == 0 and z.getinfo("first/").compress_size > 0
sys.stdout.buffer.write(out.getvalue())
`;
      const files = readZip(
        execFileSync("python3", ["-c", producer, mode]),
        limits,
      );
      const bundles = parseUploadedSkillBundles(
        files.map(({ path, data }) => ({
          path,
          content: data.toString(path.endsWith(".bin") ? "base64" : "utf8"),
          ...(path.endsWith(".bin") ? { encoding: "base64" as const } : {}),
        })),
      );
      expect(bundles.map((bundle) => bundle.rootPath)).toEqual([
        "first",
        "second",
      ]);
      expect(bundles[0].files).toEqual([
        { path: "images/图标.bin", content: "AP+A", encoding: "base64" },
      ]);
      const verified = execFileSync(
        "python3",
        [
          "-c",
          "import sys,io,zipfile; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); assert z.testzip() is None; assert z.read('first/images/图标.bin') == bytes([0,255,128]); print(len(z.namelist()))",
        ],
        { input: writeZip(files) },
      )
        .toString()
        .trim();
      expect(verified).toBe("3");
    },
  );
  it("roundtrips multiple roots, relative files and binary data", () => {
    const files = [
      { path: "one/SKILL.md", data: Buffer.from("# First") },
      { path: "one/images/icon.bin", data: Buffer.from([0, 255, 128]) },
      { path: "two/SKILL.md", data: Buffer.from("# Second") },
    ];
    expect(readZip(writeZip(files), limits)).toEqual(files);
    const bundles = parseUploadedSkillBundles(
      readZip(writeZip(files), limits).map(({ path, data }) => ({
        path,
        content: data.toString(path.endsWith(".bin") ? "base64" : "utf8"),
        ...(path.endsWith(".bin") ? { encoding: "base64" as const } : {}),
      })),
    );
    expect(bundles.map((bundle) => bundle.rootPath)).toEqual(["one", "two"]);
    expect(bundles[0].files).toEqual([
      { path: "images/icon.bin", content: "AP+A", encoding: "base64" },
    ]);
  });
  it("rejects traversal, collisions, links, corruption and resource excess", () => {
    expect(() =>
      writeZip([{ path: "../escape", data: Buffer.from("bad") }]),
    ).toThrow();
    const file = { path: "SKILL.md", data: Buffer.from("# Skill") };
    expect(() =>
      readZip(writeZip([file, { ...file, path: "skill.MD" }]), limits),
    ).toThrow();
    const linked = writeZip([file]);
    linked.writeUInt32LE(
      0xa1ff0000,
      linked.indexOf(Buffer.from("504b0102", "hex")) + 38,
    );
    expect(() => readZip(linked, limits)).toThrow();
    const corrupt = writeZip([file]);
    corrupt[30 + Buffer.byteLength(file.path)] ^= 1;
    expect(() => readZip(corrupt, limits)).toThrow();
    expect(() =>
      readZip(writeZip([file]), { ...limits, maxFileBytes: 1 }),
    ).toThrow();
    expect(() =>
      readZip(writeZip([file]), { ...limits, maxArchiveBytes: 1 }),
    ).toThrow();
    expect(() =>
      readZip(writeZip([file]), { ...limits, maxFiles: 0 }),
    ).toThrow();
  });
});
