import { db } from '@/lib/db';
import { createHash } from 'node:crypto';
import { authenticatePiPackageInstallation, PiInstallationError } from '@/lib/pi-packages/installations';
import { piInstallationErrorResponse } from '@/lib/pi-packages/http';
import { privateJson } from '@/lib/sandboxes/http-body';
export const runtime = 'nodejs';
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const authorization = req.headers.get('authorization');
    const match = /^Bearer (tppi_[a-f0-9]{64})$/.exec(authorization ?? '');
    if (!match) throw new PiInstallationError('pi_installation_unauthorized', 401);
    try { await authenticatePiPackageInstallation(id, authorization); }
    catch (error) {
      if (!(error instanceof PiInstallationError) || ![401, 403, 404].includes(error.status)) throw error;
      // After membership/release loss, the presented token may still remove its
      // own capability. This exception returns no resources and never executes tools.
    }
    const revoked = await db.piPackageClientInstallation.updateMany({ where: { id, tokenHash: createHash('sha256').update(match[1]).digest('hex') }, data: { status: 'revoked' } });
    if (!revoked.count) return privateJson({ error: 'pi_installation_not_found' }, 404);
    return privateJson({ revoked: true });
  } catch (error) { return piInstallationErrorResponse(error); }
}
