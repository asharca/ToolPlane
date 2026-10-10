import "server-only";
import { createHash } from "node:crypto";
import semver from "semver";
import { z } from "zod";
import { db } from "@/lib/db";
import { encryptSecretText, decryptSecretText } from "@/lib/security/secrets";
import { MarketError } from "@/lib/market/skills";
import { validatePiPackageSource } from "@/lib/market/pi-package-source";
import type { PiPackageCaptureOptions } from "@/lib/market/pi-package-source";
import type { PiPackageSource, Prisma } from "@prisma/client";
import {
  PI_PUBLIC_REGISTRY,
  piSourceRequest,
  piSourceUrl,
  sourceError,
} from "@/lib/market/pi-package-network";
import {
  parsePiPackageReleaseManifest,
  scanPiPackageReleaseManifest,
} from "@/lib/market/pi-package-manifest";
import { serializePiPackageArchive } from "@/lib/market/pi-package-archive";
import {
  assertRuntimeOwner,
  runtimeCanOperate,
} from "@/lib/runtime/ownership-state";

const credentialsSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("bearer"),
      token: z
        .string()
        .min(1)
        .max(4096)
        .regex(/^[\x21-\x7e]+$/),
    })
    .strict(),
  z
    .object({
      type: z.literal("basic"),
      username: z
        .string()
        .min(1)
        .max(256)
        .regex(/^[\x20-\x39\x3b-\x7e\u0080-\uFFFF]+$/),
      password: z
        .string()
        .min(1)
        .max(4096)
        .regex(/^[\x20-\x7e\u0080-\uFFFF]+$/),
    })
    .strict(),
]);
export type PiPackageSourceCredentials = z.infer<typeof credentialsSchema>;
export type PiCatalogEntry = {
  name: string;
  source: string;
  description: string;
  version: string | null;
};
export type PiCatalogPage = {
  entries: PiCatalogEntry[];
  page: number;
  hasMore: boolean;
};
type Access = { workspaceId: string; userId: string };
const safeSourceSelect = {
  id: true,
  name: true,
  kind: true,
  url: true,
  createdAt: true,
  updatedAt: true,
} as const;

async function authorize(
  input: Access,
  publisher = false,
  tx: Prisma.TransactionClient = db,
) {
  const workspace = await tx.workspace.findFirst({
    where: {
      id: input.workspaceId,
      status: "active",
      OR: [
        { ownerId: input.userId },
        {
          members: {
            some: {
              userId: input.userId,
              ...(publisher ? { role: { in: ["owner", "admin"] } } : {}),
            },
          },
        },
      ],
    },
    select: { id: true },
  });
  if (!workspace)
    throw new MarketError("not_authorized", "Workspace access was denied.");
}
function encryptedCredentials(
  value: PiPackageSourceCredentials | null,
): string | null {
  if (value === null) return null;
  const parsed = credentialsSchema.safeParse(value);
  if (!parsed.success) throw sourceError("source_credentials_invalid");
  return JSON.stringify(encryptSecretText(JSON.stringify(parsed.data)));
}
function captureOptions(source: PiPackageSource): PiPackageCaptureOptions {
  let authentication: PiPackageCaptureOptions["authentication"];
  if (source.credentialsEnc) {
    try {
      const credentials = credentialsSchema.parse(
        JSON.parse(decryptSecretText(JSON.parse(source.credentialsEnc))),
      );
      authentication = {
        url: source.url,
        authorization:
          credentials.type === "bearer"
            ? `Bearer ${credentials.token}`
            : `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")}`,
      };
    } catch {
      throw sourceError("source_credentials_invalid");
    }
  }
  return {
    sourceId: source.id,
    sourceUpdatedAt: source.updatedAt,
    ...(source.kind === "npm" ? { registry: source.url } : {}),
    ...(authentication ? { authentication } : {}),
  };
}
export async function listPiPackageSources(input: Access) {
  await authorize(input);
  const rows = await db.piPackageSource.findMany({
    where: { workspaceId: input.workspaceId },
    select: { ...safeSourceSelect, credentialsEnc: true },
    orderBy: { name: "asc" },
  });
  return rows.map(({ credentialsEnc, ...row }) => ({
    ...row,
    hasCredentials: Boolean(credentialsEnc),
  }));
}
export async function createPiPackageSource(
  input: Access & {
    name: string;
    kind: "catalog" | "npm" | "git";
    url: string;
    credentials?: PiPackageSourceCredentials;
  },
) {
  const parsed = z
    .object({
      name: z.string().trim().min(1).max(100),
      kind: z.enum(["catalog", "npm", "git"]),
      url: z.string(),
    })
    .safeParse(input);
  if (!parsed.success) throw sourceError("source_invalid");
  const url = piSourceUrl(input.url);
  if (input.kind === "npm" && !url.pathname.endsWith("/")) url.pathname += "/";
  const credentialsEnc = input.credentials
    ? encryptedCredentials(input.credentials)
    : null;
  return db.$transaction(async (tx) => {
    await authorize(input, true, tx);
    const row = await tx.piPackageSource.create({
      data: {
        workspaceId: input.workspaceId,
        name: parsed.data.name,
        kind: input.kind,
        url: url.href,
        credentialsEnc,
      },
      select: safeSourceSelect,
    });
    return { ...row, hasCredentials: Boolean(credentialsEnc) };
  });
}
export async function updatePiPackageSource(
  input: Access & {
    sourceId: string;
    name?: string;
    url?: string;
    credentials?: PiPackageSourceCredentials | null;
  },
) {
  return db.$transaction(async (tx) => {
    await authorize(input, true, tx);
    const source = await tx.piPackageSource.findFirst({
      where: { id: input.sourceId, workspaceId: input.workspaceId },
    });
    if (!source) throw sourceError("source_not_found");
    const name = input.name === undefined ? source.name : input.name.trim();
    if (!name || name.length > 100) throw sourceError("source_invalid");
    const url = piSourceUrl(input.url ?? source.url);
    if (source.kind === "npm" && !url.pathname.endsWith("/"))
      url.pathname += "/";
    // Changing scope cannot silently move an existing secret to another server/path.
    if (
      url.href !== source.url &&
      input.credentials === undefined &&
      source.credentialsEnc
    )
      throw sourceError("source_credentials_required");
    const credentialsEnc =
      input.credentials === undefined
        ? source.credentialsEnc
        : encryptedCredentials(input.credentials);
    const row = await tx.piPackageSource.update({
      where: { id: source.id },
      data: { name, url: url.href, credentialsEnc },
      select: safeSourceSelect,
    });
    return { ...row, hasCredentials: Boolean(credentialsEnc) };
  });
}
export async function deletePiPackageSource(
  input: Access & { sourceId: string },
) {
  return db.$transaction(async (tx) => {
    await authorize(input, true, tx);
    const result = await tx.piPackageSource.deleteMany({
      where: { id: input.sourceId, workspaceId: input.workspaceId },
    });
    if (!result.count) throw sourceError("source_not_found");
  });
}
function gitSource(source: string): { url: URL; ref: string } {
  validatePiPackageSource(source);
  let raw = source.replace(/^git:/, "");
  raw = raw.replace(/^git@([^:]+):/, "https://$1/");
  if (!raw.includes("://")) raw = `https://${raw}`;
  const url = new URL(raw);
  let ref = url.hash ? decodeURIComponent(url.hash.slice(1)) : "HEAD";
  url.hash = "";
  const at = url.pathname.lastIndexOf("@");
  if (at >= 0) {
    if (ref === "HEAD") ref = decodeURIComponent(url.pathname.slice(at + 1));
    url.pathname = url.pathname.slice(0, at);
  }
  if (/^[-]|[^\x21-\uFFFF]|[\x7f\\]|\.\./.test(ref))
    throw sourceError("source_invalid");
  return { url: piSourceUrl(url.href), ref };
}
export async function resolvePiPackageCaptureSource(
  input: Access & { sourceId?: string; source: string },
): Promise<PiPackageCaptureOptions> {
  await authorize(input, true);
  validatePiPackageSource(input.source);
  if (!input.sourceId) return {};
  const source = await db.piPackageSource.findFirst({
    where: { id: input.sourceId, workspaceId: input.workspaceId },
  });
  if (!source) throw sourceError("source_not_found");
  if (source.kind === "catalog")
    return { sourceId: source.id, sourceUpdatedAt: source.updatedAt };
  if ((source.kind === "npm") !== input.source.startsWith("npm:"))
    throw sourceError("source_kind_mismatch");
  if (source.kind === "git" && gitSource(input.source).url.href !== source.url)
    throw sourceError("source_scope_mismatch");
  return captureOptions(source);
}
function pageInput(input: { query?: string; page?: number }) {
  const query = (input.query ?? "").trim();
  const page = input.page ?? 1;
  if (
    query.length > 200 ||
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > 1000
  )
    throw sourceError("source_invalid");
  return { query, page };
}
function json(bytes: Buffer): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw sourceError("source_response_invalid");
  }
}
const entrySchema = z
  .object({
    name: z.string().min(1).max(240),
    source: z.string().min(1).max(2048),
    description: z.string().max(2000).default(""),
    version: z.string().max(240).nullable().default(null),
  })
  .strict();
const catalogSchema = z
  .object({
    schemaVersion: z.literal(1),
    entries: z.array(entrySchema).max(50),
    hasMore: z.boolean(),
  })
  .strict();
async function npmCatalog(
  registry: string,
  options: PiPackageCaptureOptions,
  input: { query?: string; page?: number },
): Promise<PiCatalogPage> {
  const { query, page } = pageInput(input);
  const url = new URL("-/v1/search", registry);
  url.searchParams.set("text", `keywords:pi-package ${query}`.trim());
  url.searchParams.set("size", "50");
  url.searchParams.set("from", String((page - 1) * 50));
  const schema = z.object({
    objects: z
      .array(
        z.object({
          package: z.object({
            name: z.string().max(214),
            version: z.string().max(240),
            description: z.string().max(2000).optional(),
          }),
        }),
      )
      .max(50),
    total: z.number().int().nonnegative(),
  });
  const parsed = schema.safeParse(json(await piSourceRequest(url, options)));
  if (!parsed.success) throw sourceError("source_response_invalid");
  const entries = parsed.data.objects.map(({ package: pkg }) => {
    const source = `npm:${pkg.name}`;
    validatePiPackageSource(source);
    return {
      name: pkg.name,
      source,
      description: pkg.description ?? "",
      version: pkg.version,
    };
  });
  return { entries, page, hasMore: page * 50 < parsed.data.total };
}
export async function listPiPackageSourceEntries(
  input: Access & { sourceId: string; query?: string; page?: number },
): Promise<PiCatalogPage> {
  await authorize(input);
  const source = await db.piPackageSource.findFirst({
    where: { id: input.sourceId, workspaceId: input.workspaceId },
  });
  if (!source) throw sourceError("source_not_found");
  const options = captureOptions(source);
  const { query, page } = pageInput(input);
  if (source.kind === "npm") return npmCatalog(source.url, options, input);
  if (source.kind === "git")
    return {
      entries:
        page === 1 &&
        (!query || source.name.toLowerCase().includes(query.toLowerCase()))
          ? [
              {
                name: source.name,
                source: source.url,
                description: "",
                version: null,
              },
            ]
          : [],
      page,
      hasMore: false,
    };
  const url = piSourceUrl(source.url);
  url.searchParams.set("query", query);
  url.searchParams.set("page", String(page));
  const parsed = catalogSchema.safeParse(
    json(await piSourceRequest(url, options)),
  );
  if (!parsed.success) throw sourceError("source_response_invalid");
  for (const entry of parsed.data.entries)
    validatePiPackageSource(entry.source);
  return { entries: parsed.data.entries, page, hasMore: parsed.data.hasMore };
}

/** Read the official server-rendered catalog, including its filters/pagination; never execute its scripts. */
export async function listOfficialPiPackages(
  input: { query?: string; page?: number } = {},
): Promise<PiCatalogPage> {
  const { query, page } = pageInput(input);
  const url = new URL("https://pi.dev/packages");
  // Upstream redirects empty/default parameters; keep the no-redirect credential boundary intact.
  if (query) url.searchParams.set("name", query);
  if (page > 1) url.searchParams.set("page", String(page));
  const html = (await piSourceRequest(url, { accept: "text/html" })).toString(
    "utf8",
  );
  const entries: PiCatalogEntry[] = [];
  const entities: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
  };
  const decode = (value: string) =>
    value.replace(
      /&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi,
      (original, key: string) => {
        if (!key.startsWith("#"))
          return entities[key.toLowerCase()] ?? original;
        const point =
          key[1].toLowerCase() === "x"
            ? parseInt(key.slice(2), 16)
            : Number(key.slice(1));
        return point > 0 && point <= 0x10ffff
          ? String.fromCodePoint(point)
          : original;
      },
    );
  for (const match of html.matchAll(
    /<article\b[^>]*data-package-card="true"[^>]*>[\s\S]*?<\/article>/g,
  )) {
    const name = match[0].match(/\bdata-package-name="([^"]+)"/)?.[1];
    if (!name) throw sourceError("source_response_invalid");
    const source = `npm:${decode(name)}`;
    validatePiPackageSource(source);
    const description = decode(
      match[0].match(/<p class="packages-desc">([\s\S]*?)<\/p>/)?.[1] ?? "",
    );
    const version = match[0].match(/package-version=([^"&]+)/)?.[1];
    let decodedVersion: string | null = null;
    try {
      decodedVersion = version ? decodeURIComponent(version) : null;
    } catch {
      throw sourceError("source_response_invalid");
    }
    entries.push({
      name: decode(name),
      source,
      description,
      version: decodedVersion,
    });
  }
  const count = html.match(
    /class="packages-count">(\d+)(?:-(\d+))?\s*\/\s*(\d+)(?:\s*\(of \d+\))?</,
  );
  if (!count || entries.length > 50)
    throw sourceError("source_response_invalid");
  const total = count[1] === "0" ? 0 : Number(count[3]);
  if (total > (page - 1) * 50 && !entries.length)
    throw sourceError("source_response_invalid");
  return { entries, page, hasMore: page * 50 < total };
}

/** Directory membership is checked server-side; a registry keyword or client flag is not provenance. */
export async function verifyOfficialPiPackage(
  name: string,
  version: string,
): Promise<PiCatalogEntry & { version: string; integrity: string }> {
  validatePiPackageSource(version ? `npm:${name}@${version}` : `npm:${name}`);
  if (version && semver.valid(version) !== version)
    throw sourceError("official_package_unavailable");
  let entry: PiCatalogEntry | undefined;
  for (let page = 1; page <= 1000; page += 1) {
    const result = await listOfficialPiPackages({
      query: name.slice(0, 200),
      page,
    });
    entry = result.entries.find(
      (candidate) =>
        candidate.name === name && candidate.source === `npm:${name}`,
    );
    if (entry || !result.hasMore) break;
  }
  if (!entry) throw sourceError("official_package_unavailable");
  const selected = version || entry.version || "latest";
  const metadata = z
    .object({
      name: z.literal(name),
      version: z
        .string()
        .max(240)
        .refine((value) => semver.valid(value) === value),
      dist: z.object({ integrity: z.string().min(1).max(1024) }),
    })
    .safeParse(
      json(
        await piSourceRequest(
          new URL(
            `${encodeURIComponent(name)}/${encodeURIComponent(selected)}`,
            PI_PUBLIC_REGISTRY,
          ),
          {},
        ),
      ),
    );
  if (
    !metadata.success ||
    (selected !== "latest" && metadata.data.version !== selected)
  )
    throw sourceError("official_package_unavailable");
  return {
    ...entry,
    version: metadata.data.version,
    integrity: metadata.data.dist.integrity,
  };
}

export type PiPackageTrackingView = {
  id: string;
  listingId: string;
  sourceId: string | null;
  requested: string;
  checkedAt: Date | null;
  latestIdentity: string | null;
  latestVersion: string | null;
  ignoredIdentity: string | null;
  errorCode: string | null;
  mode: "fixed" | "subscribed";
  status: "current" | "update_available" | "ignored" | "suspicious" | "error";
};
function trackingMode(requested: string): "fixed" | "subscribed" {
  if (requested.startsWith("npm:")) {
    const match = /^npm:((?:@[^/]+\/)?[^@]+)(?:@(.+))?$/.exec(requested);
    return match?.[2] && semver.valid(match[2]) ? "fixed" : "subscribed";
  }
  return /^[a-f0-9]{40}$/i.test(gitSource(requested).ref)
    ? "fixed"
    : "subscribed";
}
export async function listPiPackageTracking(
  input: Access,
): Promise<PiPackageTrackingView[]> {
  await authorize(input);
  const rows = await db.piPackageTracking.findMany({
    where: { workspaceId: input.workspaceId },
    orderBy: { updatedAt: "desc" },
  });
  return rows.map((row) => ({
    id: row.id,
    listingId: row.listingId,
    sourceId: row.sourceId,
    requested: row.requested,
    checkedAt: row.checkedAt,
    latestIdentity: row.latestIdentity,
    latestVersion: row.latestVersion,
    ignoredIdentity: row.ignoredIdentity,
    errorCode: row.errorCode,
    mode: trackingMode(row.requested),
    status:
      row.errorCode === "upstream_identity_replaced"
        ? "suspicious"
        : row.errorCode === "upstream_update_available"
          ? row.latestIdentity === row.ignoredIdentity
            ? "ignored"
            : "update_available"
          : row.errorCode
            ? "error"
            : "current",
  }));
}
async function gitIdentity(
  requested: string,
  options: PiPackageCaptureOptions,
): Promise<string> {
  const { url, ref } = gitSource(requested);
  if (/^[a-f0-9]{40}$/i.test(ref)) return ref.toLowerCase();
  url.pathname = `${url.pathname.replace(/\/$/, "")}/info/refs`;
  url.search = "?service=git-upload-pack";
  const bytes = await piSourceRequest(url, {
    ...options,
    accept: "application/x-git-upload-pack-advertisement",
  });
  const refs = new Map<string, string>();
  let offset = 0;
  while (offset < bytes.length) {
    const lengthHex = bytes.subarray(offset, offset + 4).toString("ascii");
    if (!/^[a-fA-F0-9]{4}$/.test(lengthHex))
      throw sourceError("source_response_invalid");
    const size = parseInt(lengthHex, 16);
    offset += 4;
    if (size === 0) continue;
    if (size < 4 || offset + size - 4 > bytes.length)
      throw sourceError("source_response_invalid");
    const line = bytes
      .subarray(offset, offset + size - 4)
      .toString("utf8")
      .split("\0")[0]
      .trim();
    offset += size - 4;
    const match = /^([a-f0-9]{40}) (HEAD|refs\/[^\s]+)$/.exec(line);
    if (match) refs.set(match[2], match[1]);
  }
  const value =
    refs.get(
      ref === "HEAD" || ref.startsWith("refs/") ? ref : `refs/tags/${ref}^{}`,
    ) ??
    refs.get(`refs/heads/${ref}`) ??
    refs.get(`refs/tags/${ref}`);
  if (!value) throw sourceError("source_ref_missing");
  return value;
}
export async function checkPiPackageUpdates(
  input: Access & { listingId?: string },
): Promise<PiPackageTrackingView[]> {
  await authorize(input);
  const rows = await db.piPackageTracking.findMany({
    where: {
      workspaceId: input.workspaceId,
      ...(input.listingId ? { listingId: input.listingId } : {}),
    },
    include: {
      source: true,
      listing: {
        include: {
          releases: {
            where: { reviewStatus: "approved" },
            orderBy: { version: "desc" },
            take: 1,
          },
        },
      },
    },
  });
  if (input.listingId && !rows.length) throw sourceError("tracking_not_found");
  for (const row of rows) {
    let latestIdentity: string | undefined;
    let latestVersion: string | null = null;
    let errorCode: string | null = null;
    try {
      const release = row.listing.releases[0];
      if (!release) throw sourceError("release_not_found");
      const approved = parsePiPackageReleaseManifest(
        release.manifest,
        release.checksum,
      ).package.source;
      if (approved.kind === "toolplane")
        throw sourceError("source_not_trackable");
      const options = row.source ? captureOptions(row.source) : {};
      if (approved.kind === "npm") {
        if (approved.registry && !row.source)
          throw sourceError("source_not_found");
        const match = /^npm:((?:@[^/]+\/)?[^@]+)(?:@(.+))?$/.exec(
          row.requested,
        );
        if (!match || match[1] !== approved.name)
          throw sourceError("source_invalid");
        const registry = options.registry ?? PI_PUBLIC_REGISTRY;
        if (registry !== (approved.registry ?? PI_PUBLIC_REGISTRY))
          throw sourceError("source_scope_mismatch");
        const metadata = z
          .object({
            "dist-tags": z.record(z.string(), z.string()).default({}),
            versions: z.record(z.string(), z.unknown()),
          })
          .safeParse(
            json(
              await piSourceRequest(
                new URL(encodeURIComponent(approved.name), registry),
                options,
              ),
            ),
          );
        if (!metadata.success) throw sourceError("source_response_invalid");
        const selector = match[2] ?? "latest";
        const version =
          semver.valid(selector) ??
          metadata.data["dist-tags"][selector] ??
          semver.maxSatisfying(Object.keys(metadata.data.versions), selector);
        const versionSchema = z.object({
          name: z.string(),
          version: z.string(),
          dist: z.object({ integrity: z.string().min(1).max(1024) }),
        });
        const selected = versionSchema.safeParse(
          version ? metadata.data.versions[version] : undefined,
        );
        if (
          !selected.success ||
          selected.data.name !== approved.name ||
          selected.data.version !== version
        )
          throw sourceError("source_ref_missing");
        latestVersion = selected.data.version;
        latestIdentity = JSON.stringify({
          version,
          integrity: selected.data.dist.integrity,
        });
        const captured = versionSchema.safeParse(
          metadata.data.versions[approved.version],
        );
        if (
          !captured.success ||
          captured.data.dist.integrity !== approved.integrity ||
          (row.latestVersion === version &&
            ((row.latestIdentity && row.latestIdentity !== latestIdentity) ||
              row.errorCode === "upstream_identity_replaced"))
        )
          errorCode = "upstream_identity_replaced";
        else if (version !== approved.version)
          errorCode = "upstream_update_available";
      } else {
        if (row.source?.kind === "git" && row.source.url !== approved.url)
          throw sourceError("source_scope_mismatch");
        latestIdentity = await gitIdentity(row.requested, options);
        if (latestIdentity !== approved.commit)
          errorCode = "upstream_update_available";
      }
    } catch (error) {
      errorCode =
        error instanceof MarketError ? error.code : "source_response_invalid";
    }
    await db.$transaction(async (tx) => {
      await authorize(input, false, tx);
      if (
        row.source &&
        !(await tx.piPackageSource.findFirst({
          where: {
            id: row.source.id,
            workspaceId: input.workspaceId,
            updatedAt: row.source.updatedAt,
          },
          select: { id: true },
        }))
      )
        throw sourceError("source_changed");
      await tx.piPackageTracking.updateMany({
        where: {
          id: row.id,
          workspaceId: input.workspaceId,
          updatedAt: row.updatedAt,
        },
        data: {
          checkedAt: new Date(),
          ...(latestIdentity ? { latestIdentity, latestVersion } : {}),
          errorCode,
        },
      });
    });
  }
  const result = await listPiPackageTracking(input);
  return input.listingId
    ? result.filter((row) => row.listingId === input.listingId)
    : result;
}
export async function ignorePiPackageUpdate(
  input: Access & { listingId: string; identity: string },
) {
  return db.$transaction(async (tx) => {
    await authorize(input, true, tx);
    const result = await tx.piPackageTracking.updateMany({
      where: {
        workspaceId: input.workspaceId,
        listingId: input.listingId,
        latestIdentity: input.identity,
        errorCode: "upstream_update_available",
      },
      data: { ignoredIdentity: input.identity },
    });
    if (!result.count) throw sourceError("tracking_conflict");
  });
}
export async function publishPiPackageToRegistry(
  input: Access & {
    sourceId: string;
    releaseId: string;
    tag?: string;
    confirm: true;
  },
) {
  await authorize(input, true);
  if (input.confirm !== true)
    throw sourceError("registry_confirmation_required");
  const tag = input.tag ?? "latest";
  if (!/^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/.test(tag) || semver.valid(tag))
    throw sourceError("registry_tag_invalid");
  const source = await db.piPackageSource.findFirst({
    where: { id: input.sourceId, workspaceId: input.workspaceId, kind: "npm" },
  });
  if (!source) throw sourceError("source_not_found");
  const options = captureOptions(source);
  if (!options.authentication) throw sourceError("source_credentials_required");
  const release = await db.marketRelease.findFirst({
    where: {
      id: input.releaseId,
      reviewStatus: "approved",
      listing: {
        publisherWorkspaceId: input.workspaceId,
        kind: "pi-package",
        status: "published",
      },
    },
  });
  if (!release) throw sourceError("release_not_found");
  const manifest = parsePiPackageReleaseManifest(
    release.manifest,
    release.checksum,
  );
  if (scanPiPackageReleaseManifest(manifest).status === "blocked")
    throw sourceError("registry_artifact_invalid");
  const packageJson = manifest.package.entries.find(
    (entry) => entry.path === "package/package.json",
  );
  if (packageJson?.type !== "file")
    throw sourceError("registry_artifact_invalid");
  const packageValue = json(Buffer.from(packageJson.content, "base64"));
  const parsed = z
    .object({
      name: z
        .string()
        .regex(/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/)
        .max(214),
      version: z.string(),
    })
    .passthrough()
    .safeParse(packageValue);
  if (
    !parsed.success ||
    !semver.valid(parsed.data.version) ||
    parsed.data.name !== manifest.package.name ||
    parsed.data.version !== manifest.package.version ||
    parsed.data.private === true
  )
    throw sourceError("registry_artifact_invalid");
  const { name, version } = parsed.data;
  const url = new URL(encodeURIComponent(name), source.url);
  let previous: Record<string, unknown> = {};
  try {
    const existing = json(await piSourceRequest(url, options));
    if (!existing || typeof existing !== "object" || Array.isArray(existing))
      throw sourceError("source_response_invalid");
    previous = existing as Record<string, unknown>;
  } catch (error) {
    if (!(error instanceof MarketError) || error.code !== "source_not_found")
      throw error;
  }
  const versions =
    previous.versions &&
    typeof previous.versions === "object" &&
    !Array.isArray(previous.versions)
      ? (previous.versions as Record<string, unknown>)
      : {};
  if (Object.hasOwn(versions, version))
    throw sourceError("registry_version_conflict");
  const archive = serializePiPackageArchive(manifest);
  const integrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
  const filename = `${name.replace(/^@[^/]+\//, "")}-${version}.tgz`;
  const tarball = new URL(`${name}/-/${filename}`, source.url).href;
  const body = Buffer.from(
    JSON.stringify({
      ...previous,
      _id: name,
      name,
      "dist-tags": {
        ...(previous["dist-tags"] && typeof previous["dist-tags"] === "object"
          ? previous["dist-tags"]
          : {}),
        [tag]: version,
      },
      versions: {
        ...versions,
        [version]: {
          ...parsed.data,
          _id: `${name}@${version}`,
          dist: {
            integrity,
            shasum: createHash("sha1").update(archive).digest("hex"),
            tarball,
          },
        },
      },
      _attachments: {
        ...(previous._attachments &&
        typeof previous._attachments === "object" &&
        !Array.isArray(previous._attachments)
          ? previous._attachments
          : {}),
        [filename]: {
          content_type: "application/octet-stream",
          data: archive.toString("base64"),
          length: archive.length,
        },
      },
    }),
  );
  if (body.length > 96 * 1024 * 1024)
    throw sourceError("registry_artifact_invalid");
  await authorize(input, true);
  if (
    !(await db.piPackageSource.findFirst({
      where: {
        id: source.id,
        workspaceId: input.workspaceId,
        updatedAt: source.updatedAt,
      },
      select: { id: true },
    }))
  )
    throw sourceError("source_changed");
  if (
    !(await db.marketRelease.findFirst({
      where: {
        id: release.id,
        checksum: release.checksum,
        reviewStatus: "approved",
        listing: {
          publisherWorkspaceId: input.workspaceId,
          status: "published",
        },
      },
      select: { id: true },
    }))
  )
    throw sourceError("release_not_found");
  await piSourceRequest(url, { ...options, method: "PUT", body });
  return { name, version, registry: source.url, integrity };
}

/** Metadata only: a delayed check never captures, installs, or republishes a package. */
export async function maintainPiPackageSources(
  now = new Date(),
): Promise<number> {
  assertRuntimeOwner();
  // ponytail: eight serial listings per tick; add a persisted work queue only if source volume outgrows this ceiling.
  const rows = await db.piPackageTracking.findMany({
    where: {
      workspace: { status: "active" },
      listing: { kind: "pi-package", status: "published" },
      OR: [
        { checkedAt: null },
        { checkedAt: { lt: new Date(now.getTime() - 6 * 60 * 60_000) } },
      ],
    },
    select: {
      id: true,
      workspaceId: true,
      listingId: true,
      updatedAt: true,
      workspace: { select: { ownerId: true } },
    },
    orderBy: [{ checkedAt: { sort: "asc", nulls: "first" } }, { id: "asc" }],
    take: 8,
  });
  let checked = 0;
  for (const row of rows) {
    if (!runtimeCanOperate()) break;
    try {
      await checkPiPackageUpdates({
        workspaceId: row.workspaceId,
        userId: row.workspace.ownerId,
        listingId: row.listingId,
      });
      checked++;
    } catch (error) {
      // No raw upstream error, package content, source URL or credential enters maintenance logs/state.
      if (!runtimeCanOperate()) break;
      await db.piPackageTracking.updateMany({
        where: {
          id: row.id,
          workspaceId: row.workspaceId,
          updatedAt: row.updatedAt,
        },
        data: {
          checkedAt: now,
          errorCode:
            error instanceof MarketError ? error.code : "source_unavailable",
        },
      });
    }
  }
  return checked;
}
