import { createHash } from "node:crypto";
import {
  createDockerVolume,
  removeDockerVolumeStrict,
} from "@/lib/sandboxes/runtime";

export function deploymentWorkspaceVolumeName(id: string): string {
  return `toolplane_mcp_workspace_${createHash("sha256").update(id).digest("hex")}`;
}

export async function deploymentWorkspaceMount(id: string): Promise<string[]> {
  const name = deploymentWorkspaceVolumeName(id);
  await createDockerVolume(name);
  return ["--mount", `type=volume,src=${name},dst=/workspace`];
}

export function removeDeploymentWorkspaceVolume(id: string) {
  return removeDockerVolumeStrict(deploymentWorkspaceVolumeName(id));
}
