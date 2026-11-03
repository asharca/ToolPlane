import { piCommunicationCatalog } from "@/lib/a2a/pi-tool-catalog";
import { LocalArtifactInput } from "./tool-inputs";

/** The historic wire name and catalog positions are immutable revision inputs. */
export const piArtifactTool = {
  name: "a2a_publish_artifact",
  description:
    "Publish an immutable Artifact to this task with named text, JSON, small inline bytes or file parts {path,filename?,mediaType?}/{fileId}. Workspace files stream to task storage (10 MiB/file, 100 MiB and 20 files/task); never paste large bytes or include credentials. Reuse artifactId only for identical retries. Publishing does not complete the task.",
  schema: LocalArtifactInput,
} as const;

/** Data-only catalog shared by revision capture and the runtime MCP bridge. */
export function piRuntimeCatalog(communicationEnabled: boolean) {
  return communicationEnabled
    ? [...piCommunicationCatalog, piArtifactTool]
    : [piArtifactTool];
}
