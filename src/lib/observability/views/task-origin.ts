import "server-only";
import { Prisma } from "@prisma/client";
import type { TaskGrant } from "@/lib/a2a/principal";

/** The ledger stores grants as PostgreSQL jsonb. Keep SQL and TS classification paired. */
export function entryRootSql(alias: string): Prisma.Sql {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(alias))
    throw new Error("Invalid task alias");
  const task = Prisma.raw(`"${alias}"`);
  return Prisma.sql`(${task}.grant ? 'entryPolicy' AND COALESCE(jsonb_array_length(${task}.grant->'ancestorTaskIds'), 0) = 0 AND ${task}."parentTaskId" IS NULL)`;
}

export function isEntryRootGrant(
  grant: TaskGrant,
  parentTaskId: string | null,
): boolean {
  return (
    "entryPolicy" in grant &&
    (grant.ancestorTaskIds?.length ?? 0) === 0 &&
    parentTaskId === null
  );
}
