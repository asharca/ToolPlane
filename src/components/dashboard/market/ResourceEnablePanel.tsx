import { getCurrentUser } from "@/lib/auth/current-user";
import { getWorkspaceForUser } from "@/lib/workspace/queries";
import { db } from "@/lib/db";
import { ResourceEnableForm } from "./ResourceEnableForm";

export async function ResourceEnablePanel({
  workspace,
  workspaceId,
  kind,
  resourceId,
}: {
  workspace: string;
  workspaceId: string;
  kind: "skill" | "mcp";
  resourceId: string;
}) {
  const user = await getCurrentUser();
  const authorized = user
    ? await getWorkspaceForUser(workspace, user.id)
    : null;
  if (!authorized || authorized.id !== workspaceId) return null;
  const agents = await db.agent.findMany({
    where: {
      workspaceId,
      runtimeKind: "pi-sdk",
      retiredAt: null,
      publicRuntimeAllocation: null,
    },
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      currentRevisionVersion: true,
    },
  });
  return (
    <ResourceEnableForm
      workspace={workspace}
      resourceId={resourceId}
      kind={kind}
      agents={agents.map((agent) => ({
        id: agent.id,
        name: agent.name,
        published: agent.currentRevisionVersion > 0,
      }))}
    />
  );
}
