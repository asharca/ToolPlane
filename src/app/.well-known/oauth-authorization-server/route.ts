import { getTransportSettings } from "@/lib/admin/transport-settings";
import { sandboxAuthorizationMetadata } from "@/lib/sandboxes/oauth-policy";
import { privateJson } from "@/lib/sandboxes/http-body";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    return privateJson(
      sandboxAuthorizationMetadata(await getTransportSettings()),
    );
  } catch {
    return privateJson(
      { error: "OAuth public origin is not configured." },
      503,
    );
  }
}
