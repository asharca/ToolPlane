import { metadataDocument } from "@/lib/remote-mcp/oauth/protocol";

export function GET() {
  const document = metadataDocument();
  if (!document.client_id) return new Response(null, { status: 404 });
  return Response.json(document);
}
