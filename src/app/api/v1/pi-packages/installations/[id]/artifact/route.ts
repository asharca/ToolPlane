import { getPiPackageClientArtifact } from '@/lib/pi-packages/client-artifact';
import { piInstallationErrorResponse } from '@/lib/pi-packages/http';
export const runtime = 'nodejs';
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { body, descriptor } = await getPiPackageClientArtifact(id, req.headers.get('authorization'));
    if (new URL(req.url).searchParams.get('release') !== descriptor.releaseId) return Response.json({ error: 'pi_package_release_changed' }, { status: 409, headers: { 'cache-control': 'no-store' } });
    return new Response(body, { headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'x-artifact-sha256': descriptor.artifactSha256 } });
  } catch (error) { return piInstallationErrorResponse(error); }
}
