/** Plugin source sync job projection shared by the server list and the console. */
export type PluginSourceSyncItem = {
  /** Registry entry id (plugin slug). */
  id: string;
  name: string;
  version: string;
};

export type PluginSourceSyncSummary = {
  /** Plugins indexed by this sync (active after it). */
  resourceCount: number;
  /** New or restored plugins. */
  added: PluginSourceSyncItem[];
  /** Plugins that received a new release in this sync. */
  updated: PluginSourceSyncItem[];
  /** Plugins no longer listed in registry.json. */
  removed: Omit<PluginSourceSyncItem, "version">[];
  /** Repository directories that look like plugins (contain package.json) but are not in registry.json. */
  unregistered: string[];
};

export type PluginSourceSyncJob = {
  id: string;
  status: "pending" | "running" | "succeeded" | "failed";
  /** Fixed error code; never raw provider text. */
  error: string | null;
  /** Registry entry path being processed when the job failed, if any. */
  failedPath: string | null;
  commit: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  summary: PluginSourceSyncSummary | null;
  /** A failed job whose transient error already queued a follow-up job. */
  retried: boolean;
};
