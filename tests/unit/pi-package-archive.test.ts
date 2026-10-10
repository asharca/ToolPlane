import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  readFile,
  readlink,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { serializePiPackageArchive } from "@/lib/market/pi-package-archive";
import type {
  PiPackageEntryV1,
  PiPackageManifestV1,
} from "@/lib/market/pi-package-manifest";

function file(
  path: string,
  bytes: Buffer,
  executable = false,
): PiPackageEntryV1 {
  return {
    type: "file",
    path,
    contentEncoding: "base64",
    content: bytes.toString("base64"),
    executable,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

describe("portable Pi artifact download", () => {
  it("round-trips exact bytes, executable modes and long internal links through a real tar reader deterministically", async () => {
    const long = `skills/${"review-".repeat(20)}/SKILL.md`;
    const content = Buffer.from(
      "---\nname: review\ndescription: Review a change\n---\nRead all changed files.\n",
    );
    const manifest: PiPackageManifestV1 = {
      schemaVersion: 1,
      kind: "pi-package",
      listing: {
        slug: "review",
        name: "Review",
        summary: null,
        iconUrl: null,
        tags: [],
        author: "Fixture",
      },
      package: {
        source: {
          kind: "toolplane",
          requested: "toolplane:review@1.0.0",
          name: "review",
          version: "1.0.0",
        },
        name: "review",
        version: "1.0.0",
        runtime: {
          kind: "pi-sdk",
          piVersion: "0.87.1",
          nodeMajor: 24,
          platform: "any",
          arch: "any",
        },
        root: "package",
        resources: {
          extensions: [],
          skills: [`package/${long}`],
          prompts: [],
          themes: [],
        },
        entries: [
          file(`package/${long}`, content),
          file(
            "package/run.sh",
            Buffer.from("#!/bin/sh\nprintf reviewed\n"),
            true,
          ),
          file(
            "package/package.json",
            Buffer.from('{"name":"review","version":"1.0.0"}'),
          ),
          { type: "symlink", path: "package/skill-link", target: long },
        ],
      },
    };
    const artifact = serializePiPackageArchive(manifest);
    expect(
      serializePiPackageArchive({
        ...manifest,
        package: {
          ...manifest.package,
          entries: [...manifest.package.entries].reverse(),
        },
      }),
    ).toEqual(artifact);
    const directory = await mkdtemp(join(tmpdir(), "pi-artifact-"));
    try {
      const archive = join(directory, "package.tgz");
      await writeFile(archive, artifact);
      execFileSync("tar", ["-xzf", archive, "-C", directory]);
      expect(await readFile(join(directory, "package", long))).toEqual(content);
      expect(await readlink(join(directory, "package/skill-link"))).toBe(long);
      expect((await stat(join(directory, "package/run.sh"))).mode & 0o777).toBe(
        0o755,
      );
      expect(
        JSON.parse(
          await readFile(join(directory, "package/package.json"), "utf8"),
        ),
      ).toEqual({ name: "review", version: "1.0.0" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    const entry = manifest.package.entries[0];
    if (entry.type !== "file") throw new Error("fixture");
    entry.content = Buffer.from("tampered").toString("base64");
    expect(() => serializePiPackageArchive(manifest)).toThrow(
      "pi_package_file_checksum_mismatch",
    );
  });
});
