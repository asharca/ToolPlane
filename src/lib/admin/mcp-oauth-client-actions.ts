"use server";
import { requireAdmin } from "@/lib/auth/admin";
import { db } from "@/lib/db";
import { encryptSecretText } from "@/lib/security/secrets";
import { issuerId } from "@/lib/remote-mcp/oauth/protocol";
import type {
  McpOAuthClientInput,
  McpOAuthActionResult,
} from "@/lib/remote-mcp/oauth-types";

export async function saveMcpOAuthClientAction(
  input: McpOAuthClientInput,
): Promise<McpOAuthActionResult> {
  const admin = await requireAdmin();
  let issuer: string;
  try {
    issuer = issuerId(input.issuer.trim());
  } catch {
    return { ok: false, error: "invalidIssuer" };
  }
  if (
    typeof input.clientId !== "string" ||
    !input.clientId.trim() ||
    input.clientId.length > 4096 ||
    !["none", "client_secret_basic", "client_secret_post"].includes(
      input.authMethod,
    ) ||
    (input.clientSecret !== undefined &&
      (typeof input.clientSecret !== "string" ||
        input.clientSecret.length > 16384))
  )
    return { ok: false, error: "invalidClient" };
  try {
    const encryptedSecret = input.clientSecret?.trim()
      ? encryptSecretText(input.clientSecret)
      : undefined;
    const data = {
      clientId: input.clientId.trim(),
      authMethod: input.authMethod,
      source: "manual",
      encryptedSecret,
    };
    return await db.$transaction(async (tx) => {
      const existing = await tx.mcpOAuthClient.findUnique({
        where: { issuer },
      });
      if (
        data.authMethod !== "none" &&
        !encryptedSecret &&
        !existing?.encryptedSecret
      )
        return { ok: false as const, error: "invalidClient" as const };
      await tx.mcpOAuthClient.upsert({
        where: { issuer },
        create: { ...data, issuer, createdById: admin.id },
        update: data,
      });
      return { ok: true as const };
    });
  } catch {
    return { ok: false, error: "operationFailed" };
  }
}
export async function deleteMcpOAuthClientAction(input: {
  id: string;
}): Promise<McpOAuthActionResult> {
  await requireAdmin();
  if (!input?.id || typeof input.id !== "string")
    return { ok: false, error: "notFound" };
  try {
    const { count } = await db.mcpOAuthClient.deleteMany({
      where: { id: input.id },
    });
    return count ? { ok: true } : { ok: false, error: "notFound" };
  } catch {
    return { ok: false, error: "operationFailed" };
  }
}
