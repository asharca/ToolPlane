import { handleOmpImport } from "../_shared";
export const runtime = "nodejs";
export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  return handleOmpImport(request, (await params).slug, false);
}
