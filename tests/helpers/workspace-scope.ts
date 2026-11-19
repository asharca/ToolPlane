import { PluginError } from "@/lib/plugins/catalog";
import {
  resolveWorkspaceScope,
  type WorkspaceCapability,
  type WorkspaceScope,
} from "@/lib/workspace/scope";

export async function testWorkspaceScope<C extends WorkspaceCapability>(
  id: string,
  actorUserId: string,
  capability: C,
): Promise<WorkspaceScope<C>> {
  const scope = await resolveWorkspaceScope({ id }, actorUserId, capability);
  if (!scope)
    throw new PluginError("not_authorized", "Workspace access denied.", 403);
  return scope;
}
