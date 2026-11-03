import { AdminProtocolDetail } from "@/components/admin/AdminProtocolDetail";

export const dynamic = "force-dynamic";

export default async function DetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ returnTo?: string }>;
}) {
  return (
    <AdminProtocolDetail
      kind="mcp"
      id={(await params).id}
      returnTo={(await searchParams).returnTo}
    />
  );
}
