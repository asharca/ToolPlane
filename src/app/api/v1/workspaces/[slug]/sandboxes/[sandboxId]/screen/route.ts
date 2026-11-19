import { workspaceAccessWhere } from "@/lib/workspace/scope";
import { withRequestLogging } from "@/lib/observability/http";
import { NextResponse } from "next/server";
import { resolveRequestUser } from "@/lib/auth/request-user";
import { db } from "@/lib/db";
import { connectorStatus } from "@/lib/sandboxes/connector-broker";
import { dockerSandboxDisplays } from "@/lib/sandboxes/desktop";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "cache-control": "private, no-store" };

export const GET = withRequestLogging(
  "/api/v1/workspaces/[slug]/sandboxes/[sandboxId]/screen",
  async function GET(
    req: Request,
    { params }: { params: Promise<{ slug: string; sandboxId: string }> },
  ) {
    const { slug, sandboxId } = await params;
    const user = await resolveRequestUser(req);
    if (!user)
      return NextResponse.json(
        { error: "unauthorized" },
        { status: 401, headers },
      );
    const sandbox = await db.sandbox.findFirst({
      where: {
        id: sandboxId,
        kind: { in: ["connector", "docker"] },
        workspace: {
          slug,
          ...workspaceAccessWhere(user.id),
        },
      },
      select: { id: true, kind: true },
    });
    if (!sandbox)
      return NextResponse.json(
        { error: "not found" },
        { status: 404, headers },
      );
    const displays =
      sandbox.kind === "connector"
        ? connectorStatus(sandbox.id).displays
        : await dockerSandboxDisplays(sandbox.id);
    return NextResponse.json({ displays }, { headers });
  },
);
