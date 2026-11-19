import { workspaceAccessWhere } from "@/lib/workspace/scope";
import { withRequestLogging } from "@/lib/observability/http";
import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveRequestUser } from "@/lib/auth/request-user";
import { db } from "@/lib/db";
import { isSameOriginRequest } from "@/lib/http/origin";
import { setScreenSessionControl } from "@/lib/sandboxes/connector-broker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "cache-control": "private, no-store" };
const Control = z
  .object({
    sessionId: z.string().min(1).max(64),
    control: z.boolean(),
  })
  .strict();

export const POST = withRequestLogging(
  "/api/v1/workspaces/[slug]/sandboxes/[sandboxId]/screen/control",
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
    const site = req.headers.get("sec-fetch-site");
    if (
      !req.headers.has("authorization") &&
      (!isSameOriginRequest(req) ||
        (site && !["same-origin", "none"].includes(site)))
    ) {
      return NextResponse.json(
        { error: "Same-origin request required." },
        { status: 403, headers },
      );
    }
    const sandbox = await db.sandbox.findFirst({
      where: {
        id: sandboxId,
        kind: { in: ["connector", "docker"] },
        workspace: {
          slug,
          ...workspaceAccessWhere(user.id),
        },
      },
      select: { id: true },
    });
    if (!sandbox)
      return NextResponse.json(
        { error: "not found" },
        { status: 404, headers },
      );
    const body = Control.safeParse(await req.json().catch(() => null));
    if (!body.success)
      return NextResponse.json(
        { error: "invalid screen control" },
        { status: 400, headers },
      );
    try {
      const found = await setScreenSessionControl(
        body.data.sessionId,
        sandbox.id,
        body.data.control,
      );
      if (!found)
        return NextResponse.json(
          { error: "not found" },
          { status: 404, headers },
        );
      return NextResponse.json(
        { ok: true, control: body.data.control },
        { headers },
      );
    } catch {
      return NextResponse.json(
        { error: "screen unavailable" },
        { status: 409, headers },
      );
    }
  },
);
