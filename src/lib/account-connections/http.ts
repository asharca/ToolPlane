import "server-only";
import { isDeepStrictEqual } from "node:util";
import { Prisma, type AccountConnection } from "@prisma/client";
import { resolveAccountRequestUser } from "@/lib/auth/request-user";
import {
  resolveWorkspaceScope,
  workspaceScopeWhere,
  type WorkspaceScope,
} from "@/lib/workspace/scope";
import { db } from "@/lib/db";
import { encryptSecretRecord } from "@/lib/security/secrets";
import { parseJson } from "@/lib/agents/public-api/body";
import {
  configSchema,
  connectionConfig,
  ConnectionError,
  inputSchema,
  invalidInput,
  type ConnectionInput,
} from "./config";
import {
  liveConnection,
  redirectUri,
  startOAuth,
  storedSecrets,
} from "./oauth";
import { testResource } from "./transport";

const usage = { _count: { select: { triggers: true } } } as const;
function dto(row: AccountConnection & { _count: { triggers: number } }) {
  const cfg = configSchema.parse(row.config);
  return {
    id: row.id,
    name: row.name,
    preset: row.preset,
    authType: row.authType,
    status: row.status,
    accountLabel: row.accountLabel,
    lastError: row.lastError,
    allowedHosts: cfg.allowedHosts,
    headerName: cfg.headerName ?? null,
    queryName: cfg.queryName ?? null,
    username: cfg.username ?? null,
    testUrl: cfg.testUrl ?? null,
    accountPath: cfg.accountPath ?? null,
    oauth: cfg.oauth ?? null,
    hasSecret:
      !!row.encryptedSecret && Object.keys(row.encryptedSecret).length > 0,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    usage: row._count.triggers,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
async function saveConnection(
  scope: WorkspaceScope<"manage">,
  input: ConnectionInput,
  previous: AccountConnection | null,
) {
  const config = connectionConfig(input);
  // Unreadable stored secrets behave as absent: the caller must re-enter them.
  const secrets = storedSecrets(previous?.encryptedSecret) ?? {};
  const oauth = input.authType === "oauth2";
  if (previous && previous.authType !== input.authType) throw invalidInput();
  const oldConfig = previous ? configSchema.parse(previous.config) : undefined;
  const expandsHosts =
    oldConfig &&
    config.allowedHosts.some((host) => !oldConfig.allowedHosts.includes(host));
  if (
    oldConfig &&
    !oauth &&
    !input.secret &&
    (expandsHosts ||
      config.headerName !== oldConfig.headerName ||
      config.queryName !== oldConfig.queryName ||
      config.username !== oldConfig.username)
  )
    throw invalidInput();
  if (
    oldConfig?.oauth &&
    (config.oauth?.tokenUrl !== oldConfig.oauth.tokenUrl ||
      config.oauth?.clientId !== oldConfig.oauth.clientId)
  ) {
    // A public client confirms the rebind with an explicit empty secret. An
    // omitted or empty secret must never forward an existing client secret.
    if (input.secret === undefined || (secrets.clientSecret && !input.secret))
      throw invalidInput();
  }
  const changedClient =
    oauth &&
    (!isDeepStrictEqual(oldConfig?.oauth, config.oauth) ||
      expandsHosts ||
      !!input.secret);
  if (changedClient) {
    delete secrets.accessToken;
    delete secrets.refreshToken;
  }
  if (input.secret) secrets[oauth ? "clientSecret" : "value"] = input.secret;
  if (!oauth && !secrets.value) throw invalidInput();
  const accountLabel = oauth
    ? changedClient
      ? null
      : previous?.accountLabel
    : await testResource({ config, authType: input.authType, secrets });
  const data = {
    name: input.name,
    preset: input.preset,
    authType: input.authType,
    config,
    accountLabel,
    encryptedSecret: encryptSecretRecord(secrets),
    status: oauth
      ? changedClient
        ? "pending"
        : (previous?.status ?? "pending")
      : "active",
    expiresAt: oauth && !changedClient ? previous?.expiresAt : null,
    refreshLeaseUntil: null,
    lastError: oauth && !changedClient ? previous?.lastError : null,
  };
  if (!previous)
    return db.accountConnection.create({
      data: { ...data, createdById: scope.actorUserId, workspaceId: scope.id },
      include: usage,
    });
  return db.accountConnection.update({
    where: {
      id: previous.id,
      updatedAt: previous.updatedAt,
      workspace: workspaceScopeWhere(scope),
    },
    data,
    include: usage,
  });
}

const errorResponse = (error: string, status: number) =>
  Response.json({ error }, { status });
// null clears an optional field; omission keeps the stored value.
const patchSchema = inputSchema.partial().extend({
  testUrl: inputSchema.shape.testUrl.unwrap().nullable().optional(),
  accountPath: inputSchema.shape.accountPath.unwrap().nullable().optional(),
});
export async function accountConnectionApi(
  req: Request,
  slug: string,
  id?: string,
  action?: "test" | "start",
) {
  const user = await resolveAccountRequestUser(req);
  if (!user) return errorResponse("Unauthorized", 401);
  const read = await resolveWorkspaceScope({ slug }, user.id);
  if (!read) return errorResponse("Not found", 404);
  try {
    if (req.method === "GET") {
      const rows = await db.accountConnection.findMany({
        where: { workspace: workspaceScopeWhere(read) },
        include: usage,
        orderBy: { createdAt: "asc" },
      });
      return Response.json(
        { connections: rows.map(dto), redirectUri: redirectUri() },
        { headers: { "cache-control": "no-store" } },
      );
    }
    const scope = await resolveWorkspaceScope({ slug }, user.id, "manage");
    if (!scope) return errorResponse("Forbidden", 403);
    const where = { id, workspace: workspaceScopeWhere(scope) };
    const row = id ? await db.accountConnection.findFirst({ where }) : null;
    if (id && !row) return errorResponse("Not found", 404);
    if (req.method === "DELETE" && row) {
      await db.accountConnection.delete({ where: { ...where, id: row.id } });
      return new Response(null, { status: 204 });
    }
    if (action === "start" && row)
      return Response.json(
        { authorizationUrl: await startOAuth(scope, row) },
        { headers: { "cache-control": "no-store" } },
      );
    if (action === "test" && row) {
      let snapshot = row;
      try {
        const { auth, row: current } = await liveConnection(
          { ...where, id: row.id, workspaceId: scope.id },
          AbortSignal.timeout(30000),
          true,
        );
        snapshot = current;
        const accountLabel = await testResource(auth);
        const updated = await db.accountConnection.update({
          where: { ...where, id: row.id, updatedAt: snapshot.updatedAt },
          data: { accountLabel, status: "active", lastError: null },
          include: usage,
        });
        return Response.json({ connection: dto(updated) });
      } catch (e) {
        if (!(e instanceof ConnectionError)) throw e;
        if (e.code !== "ACCOUNT_CONNECTION_EXPIRED")
          await db.accountConnection.updateMany({
            where: { ...where, updatedAt: snapshot.updatedAt },
            data: { status: "failed", lastError: e.code },
          });
        throw e;
      }
    }
    const body = await parseJson(req, patchSchema, 64 * 1024);
    if (!body.ok) throw invalidInput();
    const previous = row
      ? {
          ...configSchema.parse(row.config),
          authType: row.authType,
          name: row.name,
          preset: row.preset,
        }
      : {};
    const merged: Record<string, unknown> = { ...previous, ...body.value };
    for (const key of ["testUrl", "accountPath"] as const)
      if (merged[key] === null) delete merged[key];
    const input = inputSchema.safeParse(merged);
    if (!input.success || (!row && input.data.secret === ""))
      throw invalidInput();
    const saved = await saveConnection(scope, input.data, row);
    return Response.json(
      { connection: dto(saved) },
      { status: row ? 200 : 201 },
    );
  } catch (e) {
    if (e instanceof ConnectionError) return errorResponse(e.code, e.status);
    if (e instanceof Prisma.PrismaClientKnownRequestError) {
      if (e.code === "P2003" && req.method === "DELETE")
        return errorResponse("ACCOUNT_CONNECTION_IN_USE", 409);
      if (e.code === "P2025") return errorResponse("Not found", 404);
      if (e.code === "P2002")
        return errorResponse("INVALID_ACCOUNT_CONNECTION", 400);
    }
    return errorResponse("ACCOUNT_CONNECTION_UNREACHABLE", 500);
  }
}
