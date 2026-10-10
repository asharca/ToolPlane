import "server-only";
import { ZodError } from "zod";
import { db } from "@/lib/db";
import { resolveRequestPrincipal } from "@/lib/auth/request-user";
import { isSameOriginRequest } from "@/lib/http/origin";
import { privateJson, RequestBodyError } from "@/lib/sandboxes/http-body";
import { assertPiClientMember, PiInstallationError } from "./installations";

export function piInstallationErrorResponse(error: unknown): Response {
  if (error instanceof PiInstallationError)
    return privateJson({ error: error.code }, error.status);
  if (error instanceof ZodError || error instanceof RequestBodyError)
    return privateJson(
      { error: "pi_installation_invalid_request" },
      error instanceof RequestBodyError ? error.status : 400,
    );
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    ["P2002", "P2034"].includes(String(error.code))
  )
    return privateJson({ error: "pi_installation_conflict" }, 409);
  return privateJson({ error: "pi_installation_failed" }, 500);
}

export async function piInstallationAccountContext(req: Request, slug: string) {
  const principal = await resolveRequestPrincipal(req);
  if (!principal || principal.credential === "toolkit-token")
    throw new PiInstallationError("pi_installation_unauthorized", 401);
  if (
    req.method !== "GET" &&
    principal.credential === "session" &&
    !isSameOriginRequest(req)
  )
    throw new PiInstallationError("pi_installation_forbidden", 403);
  const workspace = await db.workspace.findUnique({
    where: { slug },
    select: { id: true },
  });
  if (!workspace)
    throw new PiInstallationError("pi_installation_not_found", 404);
  await assertPiClientMember(workspace.id, principal.user.id);
  return { workspaceId: workspace.id, userId: principal.user.id };
}
