import type { RevisionMcpToolChange } from "@/lib/revisions/upgrade-diff";
import type { ReasoningEffort, ReasoningLevel } from "@/lib/agents/constants";
import type { ParsedMessagingSession } from "@/lib/agents/messaging";
import type { ComposerReference } from "@/lib/work/composer-types";
import type { SubagentSource } from "../agents/SubagentActivity";
import type { A2AContextSummary } from "./A2AContextView";

export type WorkAgent = {
  id: string;
  name: string;
  description?: string | null;
  pinned: boolean;
  supportsWork: boolean;
  ready: boolean;
  runtimeKind: string | null;
  currentRevisionVersion?: number;
  mcpToolsUpdated?: {
    added: RevisionMcpToolChange[];
    removed: RevisionMcpToolChange[];
  } | null;
  providerId?: string | null;
  providerLabel?: string;
  model?: string | null;
  reasoningEffort?: ReasoningLevel | null;
  contextWindow?: number | null;
  contextWindowEstimated?: boolean;
  sandboxes: Array<{
    id: string;
    name: string;
    kind: string;
    deploymentId: string;
    status?: string;
    running: boolean;
    isDefault: boolean;
  }>;
};

export type WorkPart = {
  type: string;
  text?: string;
  filename?: string;
  mediaType?: string;
  url?: string;
  toolCallId?: string;
  toolName?: string;
  deploymentName?: string;
  originalToolName?: string;
  durationMs?: number;
  startedAt?: number;
  completedAt?: number;
  input?: unknown;
  output?: unknown;
  patch?: string;
  truncated?: boolean;
  firstChangedLine?: number;
  isError?: boolean;
  status?: "running" | "completed" | "failed" | "cancelled";
  runtimeKind?: string;
  data?: unknown;
  source?: SubagentSource;
  reference?: Omit<ComposerReference, "text">;
};

export type WorkActivity = {
  id: string;
  type: "runtime" | "reasoning" | "tool";
  status: "running" | "completed" | "failed" | "cancelled";
  runtimeKind?: string;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  deploymentName?: string;
  originalToolName?: string;
  durationMs?: number;
  startedAt?: number;
  completedAt?: number;
  input?: unknown;
  output?: unknown;
  patch?: string;
  truncated?: boolean;
  firstChangedLine?: number;
  isError?: boolean;
  source?: SubagentSource;
  textOffset?: number;
};

export type WorkMessage = {
  id: string;
  role: string;
  createdAt?: string;
  piEntryId?: string | null;
  parts: WorkPart[];
};
export type ConversationSummary = {
  id: string;
  agentId: string;
  title?: string | null;
  source: ParsedMessagingSession | null;
  triggerId?: string | null;
  readOnly?: boolean;
  exportable?: boolean;
};
export type ConversationDetail = ConversationSummary & {
  sandbox?: WorkItem["sandbox"];
  runtimeKind?: string;
  modelName?: string | null;
  modelOverride?: {
    providerId: string;
    model: string;
    providerName: string | null;
  } | null;
  contextWindow?: number | null;
  agentRevisionId?: string | null;
  agentRevisionVersion?: number | null;
  legacyRevisionUnresolved?: boolean;
  contextWindowEstimated?: boolean;
  readOnly: boolean;
  messages: WorkMessage[];
  reasoningEffort?: ReasoningEffort | null;
};

export type WorkSidebarAgent = {
  agent: WorkAgent;
  sessions: WorkItem[];
  chats: Array<ConversationSummary & { label: string }>;
  channels: Array<ConversationSummary & { label: string }>;
  triggers: Array<ConversationSummary & { label: string }>;
  a2aContexts: A2AContextSummary[];
};
export type WorkTreeAction = {
  kind: "edit" | "retry" | "branch";
  messageId: string;
  text?: string;
};

export type WorkPanel = "files" | "terminal" | "screen";

export type WorkItem = {
  id: string;
  agentId: string;
  title: string | null;
  titlePending?: boolean;
  /** Client-only placeholder shown before the server list includes it. */
  optimistic?: boolean;
  task: string | null;
  acceptanceCriteria: string | null;
  runtimeKind: string;
  readOnly?: boolean;
  agentRevisionId?: string | null;
  agentRevisionVersion?: number | null;
  legacyRevisionUnresolved?: boolean;
  modelName?: string | null;
  contextWindow?: number | null;
  contextWindowEstimated?: boolean;
  status: string;
  startedAt?: string | null;
  completedAt?: string | null;
  waitingQuestion: string | null;
  result: string | null;
  error: string | null;
  artifacts: string[];
  conversationId: string;
  reasoningEffort?: ReasoningEffort | null;
  workingDirectory?: string;
  sandbox: {
    id: string;
    name: string;
    kind: string;
    deploymentId: string;
    status?: string;
    running: boolean;
  } | null;
  messages: WorkMessage[];
};

export const ACTIVE_STATUSES = new Set(["queued", "running", "cancelling"]);
export const MESSAGEABLE_STATUSES = new Set([
  "idle",
  "waiting_user",
  "completed",
  "failed",
]);
export const DELETABLE_STATUSES = new Set([
  "idle",
  "completed",
  "failed",
  "cancelled",
]);
export function workHref(slug: string, id: string) {
  return `/app/${encodeURIComponent(slug)}/work?w=${encodeURIComponent(id)}`;
}

export function agentSettingsHref(
  slug: string,
  agentId: string,
  returnTo: string,
  section = "agent",
) {
  return `/app/${encodeURIComponent(slug)}/agents/${encodeURIComponent(agentId)}?settings=${encodeURIComponent(section)}&returnTo=${encodeURIComponent(returnTo)}`;
}
