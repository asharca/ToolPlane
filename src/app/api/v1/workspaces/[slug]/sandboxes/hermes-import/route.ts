import { NextResponse } from 'next/server';
import { resolveRequestUser } from '@/lib/auth/request-user';
import { getWorkspaceForUser } from '@/lib/workspace/queries';
import { getHermesArchiveSettings } from '@/lib/admin/settings';
import { hermesArchiveMaxUploadBytes } from '@/lib/agents/hermes/archive-limits';
import {
  HermesArchiveError,
  acquireHermesArchiveImportLock,
  stageHermesArchiveStream,
  type StagedHermesArchive,
} from '@/lib/agents/hermes/archive';
import {
  findHermesArchiveImport,
  importStagedHermesArchive,
} from '@/lib/agents/hermes/import';
import { isSameOriginRequest } from '@/lib/http/origin';

export const runtime = 'nodejs';
// This covers raw ingress, inspection, docker cp, the in-container copy, and
// the initial sync. Node's request timeout only covers ingress; it is shorter.
export const maxDuration = 50400;

const ARCHIVE_CONTENT_TYPES = new Set([
  'application/zip',
  'application/x-zip-compressed',
  'application/octet-stream',
]);

function response(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

function decodedHeader(req: Request, name: string, maxLength: number): string | null {
  const raw = req.headers.get(name);
  if (!raw) return null;
  try {
    const value = decodeURIComponent(raw).trim();
    return value && value.length <= maxLength ? value : null;
  } catch {
    return null;
  }
}

function optionalDecodedHeader(req: Request, name: string, maxLength: number): string | null {
  const raw = req.headers.get(name);
  if (!raw) return '';
  return decodedHeader(req, name, maxLength);
}

function contentLength(req: Request): number | null | undefined {
  const raw = req.headers.get('content-length');
  if (raw === null) return undefined;
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function acceptsArchiveContentType(req: Request): boolean {
  const type = req.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  return Boolean(type && ARCHIVE_CONTENT_TYPES.has(type));
}

function isImportId(value: string | null): value is string {
  return value !== null && /^[a-zA-Z0-9][a-zA-Z0-9_-]{15,127}$/.test(value);
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const user = await resolveRequestUser(req);
  if (!user) return response({ error: 'Unauthorized' }, 401);
  if (!isSameOriginRequest(req)) {
    return response({ error: 'This upload must be sent from the ToolPlane dashboard.' }, 403);
  }
  const workspace = await getWorkspaceForUser(slug, user.id);
  if (!workspace) return response({ error: 'Workspace not found' }, 404);

  let importLock: Awaited<ReturnType<typeof acquireHermesArchiveImportLock>> = null;
  // Until it is handed to importStagedHermesArchive, this route owns the
  // extracted directory. Keep that ownership explicit so a lost lease or a
  // database error after staging cannot leave a multi-gigabyte ZIP behind.
  let staged: StagedHermesArchive | null = null;
  try {
    if (req.headers.get('x-toolplane-hermes-archive-trusted') !== '1') {
      return response({ error: 'Confirm that you trust this archive before importing it.' }, 400);
    }
    if (!req.body) return response({ error: 'Choose a non-empty .zip archive to import.' }, 400);
    if (!acceptsArchiveContentType(req)) {
      return response({ error: 'Send the Hermes archive as a raw ZIP request body.' }, 415);
    }

    const archiveName = decodedHeader(req, 'x-toolplane-hermes-archive-name', 255);
    const importName = optionalDecodedHeader(req, 'x-toolplane-hermes-import-name', 160);
    const importId = decodedHeader(req, 'x-toolplane-hermes-import-id', 128);
    const announcedSize = contentLength(req);
    if (!archiveName || importName === null || announcedSize === null || !isImportId(importId)) {
      return response({ error: 'The archive upload metadata is invalid.' }, 400);
    }

    const completed = await findHermesArchiveImport(workspace.id, importId);
    if (completed?.status === 'completed') return response(completed.result);
    if (completed) {
      return response({
        error: 'An earlier import with this request ID did not finish. Inspect or remove that sandbox before retrying.',
      }, 409);
    }

    const settings = await getHermesArchiveSettings();
    const maxUploadBytes = hermesArchiveMaxUploadBytes(settings.hermesArchiveMaxUploadMiB);
    if (announcedSize !== undefined && announcedSize > maxUploadBytes) {
      return response({ error: `The archive must be ${settings.hermesArchiveMaxUploadMiB} MiB or smaller.` }, 413);
    }

    importLock = await acquireHermesArchiveImportLock();
    if (!importLock) {
      return response({ error: 'Another Hermes archive import is in progress. Try again after it finishes.' }, 409);
    }

    const completedWhileWaiting = await findHermesArchiveImport(workspace.id, importId);
    if (completedWhileWaiting?.status === 'completed') return response(completedWhileWaiting.result);
    if (completedWhileWaiting) {
      return response({
        error: 'An earlier import with this request ID did not finish. Inspect or remove that sandbox before retrying.',
      }, 409);
    }

    await importLock.assertHeld();
    staged = await stageHermesArchiveStream({
      name: archiveName,
      size: announcedSize,
      body: req.body,
    }, {
      maxUploadMiB: settings.hermesArchiveMaxUploadMiB,
      ...(importLock.stagingToken ? { stagingToken: importLock.stagingToken } : {}),
    });
    await importLock.assertHeld();
    // Uploading and inspecting a 10 GiB archive can take hours. Re-check
    // membership immediately before any Agent/Sandbox mutation so removal
    // from the workspace during ingress does not retain authorization.
    const currentWorkspace = await getWorkspaceForUser(slug, user.id);
    if (!currentWorkspace || currentWorkspace.id !== workspace.id) {
      return response({ error: 'Workspace not found' }, 404);
    }
    const stagedForImport = staged;
    staged = null;
    const imported = await importStagedHermesArchive({
      workspaceId: workspace.id,
      name: importName,
      staged: stagedForImport,
      importId,
    });
    return response(imported, 201);
  } catch (error) {
    const archiveError = error instanceof HermesArchiveError
      ? error
      : new HermesArchiveError('Could not import the Hermes archive.', 500);
    return response({ error: archiveError.message }, archiveError.statusCode);
  } finally {
    if (staged) await staged.cleanup().catch(() => undefined);
    if (importLock) await importLock.release().catch(() => undefined);
  }
}
