import { defineFailures, type FailureCodeOf } from "@/lib/errors/registry";

export const systemUpdateFailures = defineFailures({
  SYSTEM_UPDATE_DISABLED: "Updates are disabled.",
  SYSTEM_UPDATE_RUNTIME_UNCONFIGURED: "Runtime directory is not configured.",
  SYSTEM_UPDATE_RUNTIME_UNWRITABLE: "Runtime directory is not writable.",
  SYSTEM_UPDATE_ARTIFACT_MISSING:
    "The release does not contain the runtime artifact.",
  SYSTEM_UPDATE_CHECKSUM_MISSING:
    "The release does not contain the runtime checksum.",
  SYSTEM_UPDATE_LOOKUP_FAILED: "Could not look up the latest system release.",
  SYSTEM_UPDATE_APPLY_FAILED:
    "Could not install the system update. See the server logs for details.",
  SYSTEM_UPDATE_MANAGED_LAUNCHER_REQUIRED:
    "Online updates require the managed production launcher. No runtime files were replaced.",
  SYSTEM_UPDATE_DRAIN_FAILED:
    "Runtime shutdown was not clean. No runtime files were replaced; inspect recovery before restarting.",
  SYSTEM_UPDATE_RUNTIME_UNCERTAIN:
    "The runtime recorded an unconfirmed operation and cannot shut down cleanly. No runtime files were replaced and the runtime is still running; see runtime.owner.uncertain in the logs.",
});

export type SystemUpdateFailureCode = FailureCodeOf<
  typeof systemUpdateFailures
>;
