import { getTransportSettings } from "@/lib/admin/transport-settings";
import { sandboxProtectedResourceMetadata } from "@/lib/sandboxes/oauth-policy";
import { privateJson } from "@/lib/sandboxes/http-body";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ sandboxId: string }> },
) {
  try {
    return privateJson(
      sandboxProtectedResourceMetadata(
        (await ctx.params).sandboxId,
        await getTransportSettings(),
      ),
    );
  } catch {
    return privateJson(
      { error: "Invalid resource or OAuth public origin." },
      400,
    );
  }
}
