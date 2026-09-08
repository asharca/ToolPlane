import 'server-only';
import { Prisma } from '@prisma/client';
import { getLogContext, newRequestId } from './context';
import { sanitizeLog } from './redaction';

export type AuditEntry = {
  actorId: string;
  workspaceId?: string;
  action: string;
  targetType: string;
  targetId: string;
  outcome?: string;
  changes?: unknown;
};

// Call on the SAME transaction client as the mutation; failure aborts that mutation.
export async function writeAudit(tx: Prisma.TransactionClient, entry: AuditEntry) {
  const context = getLogContext();
  return tx.auditEvent.create({ data: {
    ...entry,
    traceId: context?.traceId ?? newRequestId(),
    requestId: context?.requestId,
    changes: sanitizeLog(entry.changes ?? {}, context?.secrets, 8192).data as Prisma.InputJsonValue,
  } });
}
