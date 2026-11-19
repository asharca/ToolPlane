import "server-only";
import { getCurrentUser } from "@/lib/auth/current-user";
import { verifyApiTokenContext } from "@/lib/auth/tokens";
import { isSameOriginRequest } from "@/lib/http/origin";
import { enrichLogContext } from "@/lib/observability/context";

type TokenContext = NonNullable<
  Awaited<ReturnType<typeof verifyApiTokenContext>>
>;
export type RequestPrincipal = {
  user: NonNullable<Awaited<ReturnType<typeof getCurrentUser>>>;
  credential: "session" | "personal-token" | "toolkit-token";
  token: TokenContext["token"] | null;
};

// Never discard credential scope or fall back to cookies after an explicit,
// invalid Authorization header. A user can own more resources than a token.
// A session cookie authenticates an unsafe method only from the expected
// origin, which defaults to this instance's public origin.
export async function resolveRequestPrincipal(
  req: Request,
  {
    allowSession = true,
    sessionOrigin,
  }: { allowSession?: boolean; sessionOrigin?: string } = {},
): Promise<RequestPrincipal | null> {
  const authorization = req.headers.get("authorization");
  if (authorization !== null) {
    const context = await verifyApiTokenContext(authorization);
    if (!context) return null;
    enrichLogContext({ actorId: context.user.id, tokenId: context.token.id });
    return {
      ...context,
      credential: context.token.toolkitId ? "toolkit-token" : "personal-token",
    };
  }
  if (!allowSession) return null;
  if (
    !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
    (sessionOrigin === undefined
      ? !isSameOriginRequest(req)
      : req.headers.get("origin") !== sessionOrigin)
  )
    return null;
  const user = await getCurrentUser();
  if (!user) return null;
  enrichLogContext({ actorId: user.id });
  return { user, token: null, credential: "session" };
}

// General routes are account-level by default. Only explicitly scoped toolkit
// routes may accept installation credentials, using resolveRequestPrincipal.
export async function resolveRequestUser(req: Request) {
  const principal = await resolveRequestPrincipal(req);
  return principal && principal.credential !== "toolkit-token"
    ? principal.user
    : null;
}

export const resolveAccountRequestUser = resolveRequestUser;

export async function resolveAgentControlRequestUser(req: Request) {
  const principal = await resolveRequestPrincipal(req, { allowSession: false });
  return principal?.credential === "personal-token" ? principal.user : null;
}
