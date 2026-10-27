import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { withRequestLogging } from "@/lib/observability/http";
import {
  GithubRegistryError,
  deriveGithubResourceRegistryWebhookSecret,
  queueGithubResourceWebhook,
} from "@/lib/market/github-registry";

export const runtime = "nodejs";
const MAX_PAYLOAD = 1024 * 1024;
function json(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}
const payloadSchema = z.object({
  repository: z.object({ full_name: z.string().max(201) }),
  ref: z.string().max(300),
  after: z.string().regex(/^[a-f0-9]{40}$/),
  deleted: z.boolean().optional(),
});
export const POST = withRequestLogging(
  "/api/v1/resource-registries/[registryId]/webhook",
  async function POST(
    request: Request,
    context: { params: Promise<{ registryId: string }> },
  ) {
    // The server-only master derives a distinct key for each stored workspace/registry pair.
    if (!process.env.TOOLPLANE_RESOURCE_REGISTRY_WEBHOOK_SECRET)
      return json({ error: "webhook_not_configured" }, 503);
    const { registryId } = await context.params;
    if (registryId.length > 128)
      return json({ error: "registry_not_found" }, 404);
    if (
      !/^sha256=[a-f0-9]{64}$/.test(
        request.headers.get("x-hub-signature-256") ?? "",
      )
    )
      return json({ error: "invalid_signature" }, 401);
    if (
      Number(request.headers.get("content-length")) > MAX_PAYLOAD ||
      !request.body
    )
      return json({ error: "payload_too_large" }, 413);
    const chunks: Uint8Array[] = [];
    const reader = request.body.getReader();
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_PAYLOAD)
          return json({ error: "payload_too_large" }, 413);
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    const raw = Buffer.concat(chunks, size);
    const registry = await db.githubResourceRegistry.findUnique({
      where: { id: registryId },
      select: { id: true, workspaceId: true, status: true },
    });
    if (!registry || registry.status === "disabled")
      return json({ error: "registry_not_found" }, 404);
    const secret = deriveGithubResourceRegistryWebhookSecret(registry);
    const expected = createHmac("sha256", secret).update(raw).digest();
    const actual = Buffer.from(
      (request.headers.get("x-hub-signature-256") ?? "").slice(7),
      "hex",
    );
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      return json({ error: "invalid_signature" }, 401);
    const event = request.headers.get("x-github-event");
    if (event === "ping") return json({ ok: true });
    if (event !== "push") return json({ ok: true, ignored: true });
    let payload: z.infer<typeof payloadSchema>;
    try {
      payload = payloadSchema.parse(JSON.parse(raw.toString("utf8")));
    } catch {
      return json({ error: "payload_invalid" }, 400);
    }
    const deliveryId = request.headers.get("x-github-delivery");
    if (!deliveryId || !/^[A-Za-z0-9-]{1,128}$/.test(deliveryId))
      return json({ error: "delivery_invalid" }, 400);
    try {
      // Queue even deletion events: a missing branch fails visibly and cannot withdraw a valid directory.
      const result = await queueGithubResourceWebhook({
        registryId,
        repository: payload.repository.full_name,
        ref: payload.ref,
        deliveryId,
      });
      return json({ ok: true, ...result }, 202);
    } catch (error) {
      return json(
        {
          error:
            error instanceof GithubRegistryError
              ? error.code
              : "webhook_queue_failed",
        },
        503,
      );
    }
  },
);
