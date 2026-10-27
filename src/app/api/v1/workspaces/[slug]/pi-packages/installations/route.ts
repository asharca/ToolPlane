import { z } from "zod";
import {
  createPiPackageClientInstallation,
  listPiPackageClientInstallations,
  piPackageBindingsSchema,
  piPackageClientSchema,
} from "@/lib/pi-packages/installations";
import { piClientSelectionsSchema } from "@/lib/pi-packages/selections";
import {
  piInstallationAccountContext,
  piInstallationErrorResponse,
} from "@/lib/pi-packages/http";
import { privateJson, readSandboxJson } from "@/lib/sandboxes/http-body";
export const runtime = "nodejs";
const createSchema = z
  .object({
    marketInstallId: z.string().min(1).max(100).optional(),
    selections: piClientSelectionsSchema.optional(),
    client: piPackageClientSchema,
    label: z.string().min(1).max(100),
    bindings: piPackageBindingsSchema.default({}),
  })
  .strict();
export async function GET(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  try {
    return privateJson(
      await listPiPackageClientInstallations(
        await piInstallationAccountContext(req, (await params).slug),
      ),
    );
  } catch (error) {
    return piInstallationErrorResponse(error);
  }
}
export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  try {
    const context = await piInstallationAccountContext(
      req,
      (await params).slug,
    );
    const input = createSchema.parse(await readSandboxJson(req, 128 * 1024));
    return privateJson(
      await createPiPackageClientInstallation({ ...context, ...input }),
      201,
    );
  } catch (error) {
    return piInstallationErrorResponse(error);
  }
}
