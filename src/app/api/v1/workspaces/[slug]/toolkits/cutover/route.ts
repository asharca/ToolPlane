import { z } from "zod";
import { withRequestLogging } from "@/lib/observability/http";
import {
  piInstallationAccountContext,
  piInstallationErrorResponse,
} from "@/lib/pi-packages/http";
import { privateJson, readSandboxJson } from "@/lib/sandboxes/http-body";
import { MarketError } from "@/lib/market/skills";
import { cutoverToolkitToPrivatePackage } from "@/lib/toolkits/cutover";

export const runtime = "nodejs";
const inputSchema = z.discriminatedUnion("mode", [
  z
    .object({
      toolkitId: z.string().min(1).max(128),
      mode: z.literal("dry-run"),
    })
    .strict(),
  z
    .object({
      toolkitId: z.string().min(1).max(128),
      mode: z.literal("apply"),
      expectedDigest: z.string().regex(/^[a-f0-9]{64}$/),
      confirmReauthorization: z.literal(true),
    })
    .strict(),
]);

export const POST = withRequestLogging(
  "/api/v1/workspaces/[slug]/toolkits/cutover",
  async function POST(
    req: Request,
    { params }: { params: Promise<{ slug: string }> },
  ) {
    try {
      const context = await piInstallationAccountContext(
        req,
        (await params).slug,
      );
      const input = inputSchema.parse(await readSandboxJson(req));
      return privateJson(
        await cutoverToolkitToPrivatePackage({ ...context, ...input }),
      );
    } catch (error) {
      if (error instanceof MarketError)
        return privateJson(
          { error: error.code },
          error.code === "not_authorized"
            ? 403
            : error.code === "source_changed" || error.code === "in_use"
              ? 409
              : 400,
        );
      return piInstallationErrorResponse(error);
    }
  },
);
