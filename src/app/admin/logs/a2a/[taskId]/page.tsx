import { AdminProtocolDetail } from "@/components/admin/AdminProtocolDetail";

export const dynamic = "force-dynamic";

export default async function DetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ taskId: string }>;
  searchParams: Promise<{ returnTo?: string }>;
}) {
  return (
    <AdminProtocolDetail
      kind="a2a"
      id={(await params).taskId}
      returnTo={(await searchParams).returnTo}
    />
  );
}
