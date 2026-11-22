import { WorkspaceSettingsContent } from "@/components/dashboard/WorkspaceSettingsContent";

export const dynamic = "force-dynamic";

export default async function SettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ section?: string }>;
}) {
  const [{ workspace }, query] = await Promise.all([params, searchParams]);
  const section =
    query.section === "files" || query.section === "connections"
      ? query.section
      : "general";
  return <WorkspaceSettingsContent slug={workspace} section={section} />;
}
