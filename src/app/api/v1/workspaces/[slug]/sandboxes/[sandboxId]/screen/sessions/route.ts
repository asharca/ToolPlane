import { withRequestLogging } from "@/lib/observability/http";
import { NextResponse } from "next/server";
import { resolveRequestUser } from "@/lib/auth/request-user";
import { db } from "@/lib/db";
import { connectorFromConfig } from "@/lib/sandboxes/connector";
import {
  createConnectorScreenSession,
  createDockerScreenSession,
} from "@/lib/sandboxes/connector-broker";
import { dockerSandboxDisplays } from "@/lib/sandboxes/desktop";
import { originFromRequest } from "@/lib/http/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "cache-control": "private, no-store" };

export const POST = withRequestLogging(
  "/api/v1/workspaces/[slug]/sandboxes/[sandboxId]/screen/sessions",
  async function POST(
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
          status: "active",
          OR: [
            { ownerId: user.id },
            { members: { some: { userId: user.id } } },
          ],
        },
      },
      select: { id: true, kind: true, config: true },
    });
    if (!sandbox)
      return NextResponse.json(
        { error: "not found" },
        { status: 404, headers },
      );

    const body = (await req.json().catch(() => null)) as {
      displayId?: unknown;
    } | null;
    const displayId =
      typeof body?.displayId === "string" ? body.displayId.trim() : "";
    if (!displayId || displayId.length > 128) {
      return NextResponse.json(
        { error: "invalid display id" },
        { status: 400, headers },
      );
    }
    const connector =
      sandbox.kind === "connector" ? connectorFromConfig(sandbox.config) : null;
    if (sandbox.kind === "connector" && !connector)
      return NextResponse.json(
        { error: "connector is not configured" },
        { status: 409, headers },
      );

    try {
      if (sandbox.kind === "docker") {
        const displays = await dockerSandboxDisplays(sandbox.id);
        if (
          !displays.some(
            (display) =>
              display.id === displayId && display.transport === "rfb",
          )
        ) {
          return NextResponse.json(
            { error: "screen unavailable" },
            { status: 409, headers },
          );
        }
      }
      const session = connector
        ? await createConnectorScreenSession(
            sandbox.id,
            displayId,
            connector.serverUrl,
          )
        : await createDockerScreenSession(
            sandbox.id,
            displayId,
            originFromRequest(req),
          );
      return NextResponse.json(session, {
        status: 201,
        headers,
      });
    } catch {
      return NextResponse.json(
        { error: "screen unavailable" },
        {
          status: 409,
          headers,
        },
      );
    }
  },
);
