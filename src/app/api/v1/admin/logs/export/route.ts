import { resolveAccountRequestUser } from "@/lib/auth/request-user";
import {
  auditWhere,
  authorizeLogs,
  resolveLogFilters,
  logWhere,
  LogAccessError,
  type LogFilters,
} from "@/lib/observability/queries";
import { db } from "@/lib/db";
import { writeAudit } from "@/lib/observability/audit";
import { z } from "zod";

export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  const user = await resolveAccountRequestUser(req);
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  try {
    await authorizeLogs({ adminId: user.id });
  } catch (error) {
    if (error instanceof LogAccessError)
      return Response.json({ error: "Forbidden" }, { status: 403 });
    throw error;
  }
  const query = Object.fromEntries(new URL(req.url).searchParams);
  let filters: LogFilters;
  try {
    filters = resolveLogFilters(query);
  } catch (error) {
    if (error instanceof z.ZodError)
      return Response.json({ error: "Invalid filters" }, { status: 400 });
    throw error;
  }
  const audit = query.tab === "audit";
  const auditFilter = audit ? auditWhere(filters) : undefined;
  const eventFilter = audit ? undefined : await logWhere(filters);
  const rows = audit
    ? await db.auditEvent.count({ where: auditFilter })
    : await db.logEvent.count({ where: eventFilter });
  await writeAudit(db, {
    actorId: user.id,
    action: "logging.exported",
    targetType: audit ? "auditEvent" : "logEvent",
    targetId: "export",
    changes: {
      rows,
      since: filters.since,
      until: filters.until,
      workspaceId: filters.workspaceId,
    },
  });
  const encoder = new TextEncoder();
  let after: { createdAt: Date; id: string } | undefined;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        req.signal.throwIfAborted();
        const cursor = after
          ? {
              OR: [
                { createdAt: { lt: after.createdAt } },
                { createdAt: after.createdAt, id: { lt: after.id } },
              ],
            }
          : {};
        const page = audit
          ? await db.auditEvent.findMany({
              where: { AND: [auditFilter ?? {}, cursor] },
              orderBy: [{ createdAt: "desc" }, { id: "desc" }],
              take: 500,
            })
          : await db.logEvent.findMany({
              where: { AND: [eventFilter ?? {}, cursor] },
              orderBy: [{ createdAt: "desc" }, { id: "desc" }],
              take: 500,
            });
        if (page.length) {
          after = page[page.length - 1];
          controller.enqueue(
            encoder.encode(
              `${page.map((row) => JSON.stringify(row)).join("\n")}\n`,
            ),
          );
        }
        if (page.length < 500) controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson",
      "content-disposition": 'attachment; filename="toolplane-logs.jsonl"',
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
