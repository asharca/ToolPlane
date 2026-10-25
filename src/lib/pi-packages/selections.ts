import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { parseSkillReleaseManifest } from "@/lib/market/skill-manifest";
import { parseMcpMarketManifest } from "@/lib/market/resources";
import {
  parsePiPackageReleaseManifest,
  type PiPackageSnapshotV1,
  type PiPackageEntryV1,
} from "@/lib/market/pi-package-manifest";
import { flattenPiPackages } from "@/lib/pi-packages/flatten";
import { PiInstallationError } from "./installations";
import { piPackageMcpAdapterSource } from "./adapter";

export const piClientSelectionsSchema = z
  .array(
    z
      .object({
        releaseId: z.string().min(1).max(200),
        checksum: z.string().regex(/^[a-f0-9]{64}$/),
        kind: z.enum(["skill", "mcp", "pi-package"]),
      })
      .strict(),
  )
  .min(1)
  .max(64)
  .refine(
    (items) =>
      new Set(items.map((item) => item.releaseId)).size === items.length,
  );
export type PiClientSelection = z.infer<
  typeof piClientSelectionsSchema
>[number];

/** Internal projection only: a registration is not a new publishable combination. */
export async function loadPiClientSelections(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  value: unknown,
) {
  const selections = piClientSelectionsSchema.parse(value);
  const snapshots: PiPackageSnapshotV1[] = [];
  for (const selection of selections) {
    const release = await tx.marketRelease.findFirst({
      where: {
        id: selection.releaseId,
        checksum: selection.checksum,
        reviewStatus: "approved",
        listing: {
          kind: selection.kind,
          status: "published",
          OR: [
            { visibility: "public" },
            { visibility: "private", publisherWorkspaceId: workspaceId },
          ],
        },
      },
    });
    if (!release) throw new PiInstallationError("pi_package_unavailable", 404);
    if (selection.kind === "pi-package") {
      snapshots.push(
        parsePiPackageReleaseManifest(release.manifest, release.checksum)
          .package,
      );
      continue;
    }
    const identity = createHash("sha256")
      .update(release.id)
      .digest("hex")
      .slice(0, 20);
    const name = `resource-${identity}`;
    const entries: PiPackageEntryV1[] = [];
    const resources = {
      skills: [] as string[],
      extensions: [] as string[],
      prompts: [] as string[],
      themes: [] as string[],
    };
    const mcp: NonNullable<PiPackageSnapshotV1["toolplane"]>["mcp"] = [];
    const file = (path: string, bytes: Buffer) =>
      entries.push({
        type: "file",
        path,
        content: bytes.toString("base64"),
        contentEncoding: "base64",
        executable: false,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    if (selection.kind === "skill") {
      const { skill } = parseSkillReleaseManifest(
        release.manifest,
        release.checksum,
      );
      const root = `package/skills/${identity}`;
      resources.skills.push(root);
      file(`${root}/SKILL.md`, Buffer.from(skill.content));
      for (const item of skill.files)
        file(
          `${root}/${item.path}`,
          Buffer.from(
            item.content,
            item.encoding === "base64" ? "base64" : "utf8",
          ),
        );
    } else {
      const { mcp: definition } = parseMcpMarketManifest(
        release.manifest,
        release.checksum,
      );
      const catalog = definition.toolCatalog ?? [];
      const tools =
        definition.toolExposure === "allowlist"
          ? definition.allowedTools
          : catalog.map((tool) => tool.name);
      if (!tools.length)
        throw new PiInstallationError("pi_package_tool_unavailable", 409);
      mcp.push({ key: `mcp-${identity}`, name: definition.name, tools });
      resources.extensions.push("package/extensions/toolplane-mcp.mjs");
      file(
        "package/extensions/toolplane-mcp.mjs",
        Buffer.from(piPackageMcpAdapterSource()),
      );
    }
    file(
      "package/package.json",
      Buffer.from(
        JSON.stringify({
          name,
          version: "1.0.0",
          pi: Object.fromEntries(
            Object.entries(resources).map(([kind, paths]) => [
              kind,
              paths.map((path) => path.slice(8)),
            ]),
          ),
        }),
      ),
    );
    snapshots.push({
      name,
      version: "1.0.0",
      root: "package",
      source: {
        kind: "toolplane",
        requested: `toolplane:${name}@1.0.0`,
        name,
        version: "1.0.0",
      },
      runtime: {
        kind: "pi-sdk",
        piVersion: "0.87.1",
        nodeMajor: 24,
        platform: "any",
        arch: "any",
      },
      entries,
      resources,
      toolplane: { schemaVersion: 1, mcp },
    });
  }
  const snapshot = flattenPiPackages(snapshots);
  const packageBytes = Buffer.from(
    JSON.stringify({
      name: snapshot.name,
      version: snapshot.version,
      type: "module",
      pi: Object.fromEntries(
        Object.entries(snapshot.resources).map(([kind, paths]) => [
          kind,
          paths.map((path) => path.slice(8)),
        ]),
      ),
      toolplane: snapshot.toolplane,
    }),
  );
  snapshot.entries.push({
    type: "file",
    path: "package/package.json",
    content: packageBytes.toString("base64"),
    contentEncoding: "base64",
    executable: false,
    sha256: createHash("sha256").update(packageBytes).digest("hex"),
  });
  const manifest = parsePiPackageReleaseManifest({
    schemaVersion: 1,
    kind: "pi-package",
    package: snapshot,
    listing: {
      slug: "client-selection",
      name: "Client selection",
      summary: null,
      iconUrl: null,
      tags: [],
      author: "ToolPlane",
    },
  });
  return { selections, manifest };
}
