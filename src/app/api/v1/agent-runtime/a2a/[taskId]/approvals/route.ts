import { handleRuntimeApprovals } from '@/lib/a2a/approval-http';
export const runtime = 'nodejs';
export async function POST(req: Request, { params }: { params: Promise<{ taskId: string }> }) {
  return handleRuntimeApprovals(req, (await params).taskId);
}
