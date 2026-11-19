import "server-only";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import {
  DEFAULT_USER_LIMITS,
  USER_LIMIT_RANGES,
  type UserLimits,
} from "./user-limit-policy";

export const USER_LIMITS_KEY = "user.limits";

const overrideFields = {
  storageQuotaBytes: true,
  maxOwnedWorkspaces: true,
} as const;
type LimitOverrides = {
  storageQuotaBytes: bigint | null;
  maxOwnedWorkspaces: number | null;
};

async function readUserLimitDefaults(
  tx: Prisma.TransactionClient,
): Promise<UserLimits & { source: "database" | "default" }> {
  const row = await tx.systemSetting.findUnique({
    where: { key: USER_LIMITS_KEY },
    select: { value: true },
  });
  if (row) {
    try {
      const value: unknown = JSON.parse(row.value);
      if (value && typeof value === "object") {
        const { storageQuotaBytes, maxOwnedWorkspaces } = value as Record<
          string,
          unknown
        >;
        if (
          inRange(storageQuotaBytes, USER_LIMIT_RANGES.storageQuotaBytes) &&
          inRange(maxOwnedWorkspaces, USER_LIMIT_RANGES.maxOwnedWorkspaces)
        ) {
          return { storageQuotaBytes, maxOwnedWorkspaces, source: "database" };
        }
      }
    } catch {
      // A malformed setting does not override the built-in defaults.
    }
  }
  return { ...DEFAULT_USER_LIMITS, source: "default" };
}

export function getUserLimitDefaults(): Promise<
  UserLimits & { source: "database" | "default" }
> {
  return readUserLimitDefaults(db);
}

function inRange(
  value: unknown,
  [min, max]: readonly [number, number],
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= min &&
    value <= max
  );
}

export async function effectiveUserLimits(
  tx: Prisma.TransactionClient,
  overrides: LimitOverrides,
): Promise<{ storageQuotaBytes: bigint; maxOwnedWorkspaces: number }> {
  const defaults = await readUserLimitDefaults(tx);
  return {
    storageQuotaBytes:
      overrides.storageQuotaBytes ?? BigInt(defaults.storageQuotaBytes),
    maxOwnedWorkspaces:
      overrides.maxOwnedWorkspaces ?? defaults.maxOwnedWorkspaces,
  };
}

/** For existing workspaces, acquire their lock before calling this function. */
export function lockUserLimits(
  tx: Prisma.TransactionClient,
  userId: string,
  otherUserId = userId,
) {
  return tx.$queryRaw<(LimitOverrides & { id: string })[]>`
    SELECT "id", "storageQuotaBytes", "maxOwnedWorkspaces" FROM "User"
    WHERE "id" IN (${userId}, ${otherUserId}) ORDER BY "id" FOR UPDATE`;
}

async function sumStorage(
  tx: Prisma.TransactionClient,
  workspaces: Prisma.Sql,
) {
  const [usage] = await tx.$queryRaw<{ bytes: bigint }[]>`
    WITH workspaces AS (${workspaces})
    SELECT COALESCE(SUM(files.size), 0) AS bytes FROM (
      SELECT a."size" FROM "WorkspaceAttachment" a
      JOIN workspaces w ON w.id = a."workspaceId"
      UNION ALL
      SELECT f."size" FROM "A2ATaskFile" f
      JOIN workspaces w ON w.id = f."workspaceId"
      WHERE f."storagePath" IS NOT NULL
    ) files`;
  return usage.bytes;
}

export function ownedStorageBytes(
  tx: Prisma.TransactionClient,
  userId: string,
) {
  return sumStorage(
    tx,
    Prisma.sql`SELECT id FROM "Workspace" WHERE "ownerId" = ${userId}`,
  );
}

export function workspaceStorageBytes(
  tx: Prisma.TransactionClient,
  workspaceId: string,
) {
  return sumStorage(
    tx,
    Prisma.sql`SELECT id FROM "Workspace" WHERE "id" = ${workspaceId}`,
  );
}

export async function getWorkspaceStorageBytes(
  workspaceId: string,
): Promise<number> {
  return Number(await workspaceStorageBytes(db, workspaceId));
}

export async function getUserQuotaSummary(userId: string): Promise<{
  usedBytes: number;
  storageQuotaBytes: number;
  ownedWorkspaces: number;
  maxOwnedWorkspaces: number;
  overrides: {
    storageQuotaBytes: number | null;
    maxOwnedWorkspaces: number | null;
  };
}> {
  const [user, usedBytes, ownedWorkspaces] = await Promise.all([
    db.user.findUniqueOrThrow({
      where: { id: userId },
      select: overrideFields,
    }),
    ownedStorageBytes(db, userId),
    db.workspace.count({ where: { ownerId: userId } }),
  ]);
  const limits = await effectiveUserLimits(db, user);
  return {
    usedBytes: Number(usedBytes),
    storageQuotaBytes: Number(limits.storageQuotaBytes),
    ownedWorkspaces,
    maxOwnedWorkspaces: limits.maxOwnedWorkspaces,
    overrides: {
      storageQuotaBytes:
        user.storageQuotaBytes === null ? null : Number(user.storageQuotaBytes),
      maxOwnedWorkspaces: user.maxOwnedWorkspaces,
    },
  };
}

export class StorageQuotaExceededError extends Error {
  constructor() {
    super("Storage quota exceeded.");
  }
}

type LockedStorageWorkspace = { ownerId: string; status: string };

export async function lockStorageWorkspace(
  tx: Prisma.TransactionClient,
  workspaceId: string,
): Promise<LockedStorageWorkspace | undefined> {
  const [workspace] = await tx.$queryRaw<LockedStorageWorkspace[]>`
    SELECT "ownerId", "status"::text AS "status"
    FROM "Workspace" WHERE "id" = ${workspaceId} FOR UPDATE`;
  return workspace;
}

/** Caller locks the workspace first and persists the reserved size before committing. */
export async function reserveWorkspaceStorage(
  tx: Prisma.TransactionClient,
  workspace: LockedStorageWorkspace,
  cap: number,
  uploaderId = workspace.ownerId,
): Promise<number> {
  // The attachment insert also takes a foreign-key lock on its uploader.
  const users = await lockUserLimits(tx, workspace.ownerId, uploaderId);
  const owner = users.find((user) => user.id === workspace.ownerId);
  if (!owner) throw new Error("Workspace owner not found.");
  const { storageQuotaBytes } = await effectiveUserLimits(tx, owner);
  const remaining = storageQuotaBytes - (await ownedStorageBytes(tx, owner.id));
  if (remaining <= BigInt(0)) throw new StorageQuotaExceededError();
  return remaining < BigInt(cap) ? Number(remaining) : cap;
}
