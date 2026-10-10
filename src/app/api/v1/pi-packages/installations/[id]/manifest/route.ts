import { getPiPackageClientArtifact } from "@/lib/pi-packages/client-artifact";
import { piInstallationErrorResponse } from "@/lib/pi-packages/http";
import { privateJson } from "@/lib/sandboxes/http-body";
export const runtime = "nodejs";
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { descriptor } = await getPiPackageClientArtifact(
      id,
      req.headers.get("authorization"),
    );
    return privateJson(descriptor);
  } catch (error) {
    return piInstallationErrorResponse(error);
  }
}
