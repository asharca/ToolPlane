import { z } from 'zod';
import { updatePiPackageClientInstallation, revokePiPackageClientInstallation, piPackageBindingsSchema } from '@/lib/pi-packages/installations';
import { piInstallationAccountContext, piInstallationErrorResponse } from '@/lib/pi-packages/http';
import { privateJson, readSandboxJson } from '@/lib/sandboxes/http-body';
export const runtime = 'nodejs';
const updateSchema = z.object({ releaseId: z.string().min(1).max(100), bindings: piPackageBindingsSchema, confirmExpandedPrivileges: z.boolean().optional() }).strict();
export async function PATCH(req: Request, { params }: { params: Promise<{ slug: string; id: string }> }) {
  try {
    const { slug, id } = await params;
    const context = await piInstallationAccountContext(req, slug);
    const input = updateSchema.parse(await readSandboxJson(req, 128 * 1024));
    return privateJson(await updatePiPackageClientInstallation({ ...context, ...input, installationId: id }));
  } catch (error) { return piInstallationErrorResponse(error); }
}
export async function DELETE(req: Request, { params }: { params: Promise<{ slug: string; id: string }> }) {
  try {
    const { slug, id } = await params;
    await revokePiPackageClientInstallation({ ...await piInstallationAccountContext(req, slug), installationId: id });
    return privateJson({ revoked: true });
  } catch (error) { return piInstallationErrorResponse(error); }
}
