import { z } from "zod";
import { withRequestLogging } from "@/lib/observability/http";
import {
  piInstallationAccountContext,
  piInstallationErrorResponse,
} from "@/lib/pi-packages/http";
import {
  createPiPackageClientInstallation,
  listPiPackageClientInstallations,
  piPackageBindingsSchema,
  piPackageClientSchema,
} from "@/lib/pi-packages/installations";
import { piClientSelectionsSchema } from "@/lib/pi-packages/selections";
import { readSandboxJson, privateJson } from "@/lib/sandboxes/http-body";
export const runtime = "nodejs";
export const GET = withRequestLogging(
  "/api/v1/pi-packages/registrations",
  async function GET(req: Request) {
    try {
      const context = await piInstallationAccountContext(
        req,
        new URL(req.url).searchParams.get("workspace") ?? "",
      );
      return privateJson({
        installations: await listPiPackageClientInstallations(context),
      });
    } catch (error) {
      return piInstallationErrorResponse(error);
    }
  },
);
export const POST = withRequestLogging(
  "/api/v1/pi-packages/registrations",
  async function POST(req: Request) {
    try {
      const body = z
        .object({
          workspace: z.string().min(1),
          client: piPackageClientSchema,
          label: z.string().min(1).max(100),
          marketInstallId: z.string().min(1).optional(),
          selections: piClientSelectionsSchema.optional(),
          bindings: piPackageBindingsSchema,
        })
        .strict()
        .parse(await readSandboxJson(req, 128 * 1024));
      const context = await piInstallationAccountContext(req, body.workspace);
      return privateJson(
        await createPiPackageClientInstallation({ ...body, ...context }),
        201,
      );
    } catch (error) {
      return piInstallationErrorResponse(error);
    }
  },
);
