import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db } from "@/lib/db";
import {
  startProcess,
  killProcess,
  liveStatus,
} from "@/lib/process/supervisor";
import { resolveSpawnSpec } from "@/lib/process/spawn-spec";
import { assertRuntimeOwner } from "@/lib/runtime/ownership-state";
import { beginWorkspaceOperation } from "@/lib/workspace/operation-gate";
import { withLogContext } from "@/lib/observability/context";
import type { Prisma } from "@prisma/client";
import { sandboxManagementUser } from "./mcp-management";
import { privateJson, readSandboxJson, RequestBodyError } from "./http-body";
import {
  prepareSshServerRecord,
  scanSshHostKeys,
  SshHost,
  SshPort,
  SshServerError,
  SshServerInput,
} from "./ssh-servers";

const Create = SshServerInput.extend({
  name: z.string().trim().min(1).max(80),
  acknowledgeHostAccess: z.literal(true),
}).strict();
const Scan = z.object({ host: SshHost, port: SshPort.default(22) }).strict();

// Host-key scans and login tests open outbound connections; bound them per user.
const attempts = new Map<string, { until: number; count: number }>();
function admit(userId: string) {
  const now = Date.now();
  for (const [key, value] of attempts)
    if (value.until <= now) attempts.delete(key);
  const entry = attempts.get(userId);
  if (!entry) {
    attempts.set(userId, { until: now + 60_000, count: 1 });
    return true;
  }
  return ++entry.count <= 20;
}

const failure = (code: string, error: string, status: number) =>
  privateJson({ error, code }, status);

async function authorize(req: Request, workspaceId: string) {
  const user = await sandboxManagementUser(req);
  if (!user) return null;
  const workspace = await db.workspace.findFirst({
    where: {
      id: workspaceId,
      status: "active",
      OR: [{ ownerId: user.id }, { members: { some: { userId: user.id } } }],
    },
    select: { id: true, slug: true },
  });
  return workspace ? { user, workspace } : null;
}

function sshFailure(error: unknown) {
  if (error instanceof SshServerError)
    return failure(error.code, "SSH server check failed.", error.status);
  if (error instanceof RequestBodyError)
    return failure("SSH_INVALID_INPUT", "Invalid request.", error.status);
  return failure("SSH_UNAVAILABLE", "SSH sandbox operation failed.", 409);
}

/** POST host and port; returns the server's host keys for user confirmation. */
export function handleSshHostKeys(
  req: Request,
  workspaceId: string,
): Promise<Response> {
  return withLogContext({ suppressPayload: true }, async () => {
    const access = await authorize(req, workspaceId);
    if (!access) return failure("SSH_UNAVAILABLE", "Workspace not found.", 404);
    if (!admit(access.user.id))
      return failure("SSH_RATE_LIMITED", "Too many SSH checks.", 429);
    try {
      const parsed = Scan.safeParse(await readSandboxJson(req, 4_096));
      if (!parsed.success)
        return failure(
          "SSH_INVALID_INPUT",
          "A host and port are required.",
          400,
        );
      return privateJson(
        await scanSshHostKeys(parsed.data.host, parsed.data.port),
      );
    } catch (error) {
      return sshFailure(error);
    }
  });
}

/** Create an SSH sandbox only after a real login with the submitted credentials. */
export function handleSshSandboxes(
  req: Request,
  workspaceId: string,
): Promise<Response> {
  return withLogContext({ suppressPayload: true }, async () => {
    const access = await authorize(req, workspaceId);
    if (!access) return failure("SSH_UNAVAILABLE", "Workspace not found.", 404);
    if (req.method !== "POST")
      return failure("SSH_INVALID_INPUT", "Method not allowed.", 405);
    if (!admit(access.user.id))
      return failure("SSH_RATE_LIMITED", "Too many SSH checks.", 429);
    const release = beginWorkspaceOperation(workspaceId);
    if (!release)
      return failure("SSH_UNAVAILABLE", "Workspace unavailable.", 409);
    try {
      const parsed = Create.safeParse(await readSandboxJson(req, 64_000));
      if (!parsed.success)
        return failure(
          "SSH_INVALID_INPUT",
          "Name, host, username, absolute root, credentials, confirmed host keys and acknowledgeHostAccess=true are required.",
          400,
        );
      const { name, acknowledgeHostAccess: _, ...input } = parsed.data;
      const server = await prepareSshServerRecord(input);
      assertRuntimeOwner();
      const id = randomUUID();
      const deploymentId = randomUUID();
      const deployment = await db.$transaction(async (tx) => {
        const row = await tx.deployment.create({
          data: {
            id: deploymentId,
            workspaceId,
            name: `Sandbox: ${name}`,
            serverId: null,
            source: "sandbox",
            sourceRef: `ssh:${server.username}@${server.host}:${server.port}`,
            status: "provisioning",
            installCfg: {
              sandboxId: id,
              kind: "ssh",
              env: {},
              network: "isolated",
            },
          },
        });
        await tx.sandbox.create({
          data: {
            id,
            workspaceId,
            deploymentId,
            name,
            slug: `ssh-${id}`,
            kind: "ssh",
            image: null,
            network: "isolated",
            config: { env: {} },
            sshServer: {
              create: {
                host: server.host,
                port: server.port,
                username: server.username,
                root: server.root,
                authType: server.authType,
                hostKeys: server.hostKeys as Prisma.InputJsonValue,
                encryptedSecret:
                  server.encryptedSecret as Prisma.InputJsonValue,
                ...(server.encryptedPassphrase
                  ? {
                      encryptedPassphrase:
                        server.encryptedPassphrase as Prisma.InputJsonValue,
                    }
                  : {}),
              },
            },
          },
        });
        return row;
      });
      try {
        await startProcess(deploymentId, resolveSpawnSpec(deployment), {
          awaitReady: true,
          workspaceId,
        });
      } catch {
        // The login already succeeded; leave the record for an explicit retry.
      }
      if (liveStatus(deploymentId) !== "running") {
        await killProcess(deploymentId, { preventRestart: true }).catch(
          () => undefined,
        );
        await db.deployment.updateMany({
          where: { id: deploymentId, workspaceId },
          data: { status: "error" },
        });
      }
      return privateJson(
        {
          id,
          deploymentId,
          status: liveStatus(deploymentId) ?? "error",
          consolePath: `/app/${access.workspace.slug}/sandboxes/${id}`,
        },
        201,
      );
    } catch (error) {
      return sshFailure(error);
    } finally {
      release();
    }
  });
}
