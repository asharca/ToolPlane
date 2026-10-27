import { z } from "zod";
import { withRequestLogging } from "@/lib/observability/http";
import {
  piInstallationAccountContext,
  piInstallationErrorResponse,
} from "@/lib/pi-packages/http";
import { revokeDangerousMarketRelease } from "@/lib/market/revocation";
import { MarketError } from "@/lib/market/skills";
import { privateJson, readSandboxJson } from "@/lib/sandboxes/http-body";

export const runtime = "nodejs";
export const POST = withRequestLogging(
  "/api/v1/pi-packages/releases/[releaseId]/revoke",
  async function POST(
    req: Request,
    { params }: { params: Promise<{ releaseId: string }> },
  ) {
    try {
      const { releaseId } = await params;
      const body = z
        .object({
          workspace: z.string().min(1),
          reason: z.string().trim().min(1).max(2000),
        })
        .strict()
        .parse(await readSandboxJson(req));
      const context = await piInstallationAccountContext(req, body.workspace);
      return privateJson(
        await revokeDangerousMarketRelease({
          ...context,
          releaseId,
          reason: body.reason,
        }),
      );
    } catch (error) {
      if (error instanceof MarketError)
        return privateJson(
          { error: error.code },
          error.code === "not_authorized" ? 403 : 400,
        );
      return piInstallationErrorResponse(error);
    }
  },
);
