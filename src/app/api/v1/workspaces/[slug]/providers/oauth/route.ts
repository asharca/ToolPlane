import { z } from "zod";
import { resolveRequestUser } from "@/lib/auth/request-user";
import {
  cancelProviderOAuthSession,
  getProviderOAuthSessionStatus,
  ProviderOAuthError,
  startProviderOAuthSession,
  submitProviderOAuthInput,
} from "@/lib/agents/provider-oauth";
import { withRequestLogging } from "@/lib/observability/http";
import { resolveWorkspaceScope } from "@/lib/workspace/scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RequestSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("start"),
    format: z.string().trim().min(1).max(120),
    name: z.string().trim().min(1).max(120),
    baseUrl: z.string().trim().max(2_000).optional(),
    providerId: z.string().trim().min(1).max(120).optional(),
    loginMethod: z.string().trim().max(64).optional(),
    enterpriseDomain: z.string().trim().max(500).optional(),
  }),
  z.object({
    action: z.literal("status"),
    sessionId: z.string().trim().min(1).max(120),
  }),
  z.object({
    action: z.literal("input"),
    sessionId: z.string().trim().min(1).max(120),
    value: z.string().max(8_000),
  }),
  z.object({
    action: z.literal("cancel"),
    sessionId: z.string().trim().min(1).max(120),
  }),
]);

export const POST = withRequestLogging(
  "/api/v1/workspaces/[slug]/providers/oauth",
  async function POST(
    req: Request,
    { params }: { params: Promise<{ slug: string }> },
  ) {
    const user = await resolveRequestUser(req);
    if (!user) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    const { slug } = await params;
    const workspace = await resolveWorkspaceScope({ slug }, user.id);
    if (!workspace) {
      return Response.json({ error: "Workspace not found" }, { status: 404 });
    }

    let rawBody: unknown;
    try {
      rawBody = await req.json();
    } catch {
      return Response.json({ error: "Invalid request body" }, { status: 400 });
    }

    const parsed = RequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return Response.json({ error: "Invalid request body" }, { status: 400 });
    }

    const body = parsed.data;
    try {
      if (body.action === "start") {
        const snapshot = await startProviderOAuthSession({
          scope: workspace,
          userId: user.id,
          format: body.format,
          name: body.name,
          baseUrl: body.baseUrl,
          providerId: body.providerId,
          loginMethod: body.loginMethod,
          enterpriseDomain: body.enterpriseDomain,
        });
        return Response.json(snapshot);
      }
      if (body.action === "status") {
        const snapshot = getProviderOAuthSessionStatus({
          workspaceId: workspace.id,
          userId: user.id,
          sessionId: body.sessionId,
        });
        return Response.json(snapshot);
      }
      if (body.action === "input") {
        const snapshot = await submitProviderOAuthInput({
          workspaceId: workspace.id,
          userId: user.id,
          sessionId: body.sessionId,
          value: body.value,
        });
        return Response.json(snapshot);
      }
      const snapshot = cancelProviderOAuthSession({
        workspaceId: workspace.id,
        userId: user.id,
        sessionId: body.sessionId,
      });
      return Response.json(snapshot);
    } catch (error) {
      if (error instanceof ProviderOAuthError) {
        const status =
          error.code === "session_not_found" ||
          error.code === "provider_not_found"
            ? 404
            : 400;
        return Response.json(
          { error: error.message, code: error.code },
          { status },
        );
      }
      return Response.json(
        { error: "Could not process provider sign-in." },
        { status: 500 },
      );
    }
  },
);
