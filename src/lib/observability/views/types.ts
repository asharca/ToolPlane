export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
export type ViewScope =
  | { kind: "workspace"; workspaceId: string; userId: string }
  | { kind: "admin"; userId: string; workspaceId?: string };
export type BodyState =
  | "available"
  | "truncated"
  | "expired"
  | "restricted"
  | "unavailable";
export type Party = {
  kind:
    | "user"
    | "agent"
    | "token"
    | "client"
    | "endpoint"
    | "remote-agent"
    | "unknown";
  id: string | null;
  name: string;
};
export type NamedEntity = { id: string; name: string };
export type TimeFilter = {
  range?: "1h" | "24h" | "7d" | "30d" | "custom";
  since?: string;
  until?: string;
  workspaceId?: string;
};
export type McpCallFilter = TimeFilter & {
  deploymentId?: string;
  tool?: string;
  method?: string;
  callerKind?: "user" | "agent" | "token";
  outcome?: "success" | "error";
  slow?: boolean;
  slowMs?: number;
  q?: string;
  source?: "calls" | "internal" | "tools";
};
export type A2ATaskFilter = TimeFilter & {
  agentId?: string;
  direction?: "inbound" | "outbound" | "internal";
  state?: string;
  q?: string;
};
export type ViewStats = {
  total: number;
  success: number;
  error: number;
  slow: number;
  averageDurationMs: number | null;
};
export type ViewPage<T> = {
  items: T[];
  nextCursor: string | null;
  stats: ViewStats;
};
export type McpCallSummary = {
  id: string;
  callId: string | null;
  eventId: string;
  createdAt: string;
  workspace: NamedEntity | null;
  deployment: NamedEntity | null;
  server: NamedEntity | null;
  caller: Omit<Party, "name"> & { name: string | null };
  method: string | null;
  tool: string | null;
  outcome: string;
  durationMs: number | null;
  httpStatus: number | null;
  error: string | null;
};
export type TimelineEntry = {
  id: string;
  time: string;
  level: string;
  message: string;
  state?: string;
  taskId?: string;
  eventName?: string;
};
export type McpCallDetail = {
  summary: McpCallSummary;
  source: "calls" | "internal" | "tools";
  request: JsonValue | null;
  response: JsonValue | null;
  upstream?: {
    eventId: string;
    request: JsonValue | null;
    response: JsonValue | null;
    bodyState: BodyState;
  };
  trace: TimelineEntry[];
  bodyState: BodyState;
};
export type A2ATaskSummary = {
  taskId: string;
  contextId: string | null;
  rootTaskId: string;
  workspace: NamedEntity | null;
  from: Party;
  to: Party;
  direction: "inbound" | "outbound" | "internal";
  state: string;
  startedAt: string;
  settledAt: string | null;
  durationMs: number | null;
  childCount: number;
  error?: string;
};
export type A2ATaskNode = {
  taskId: string;
  parentTaskId: string | null;
  rootTaskId: string;
  state: string;
  from: Party;
  to: Party;
  startedAt: string;
  settledAt: string | null;
};
export type A2AMessageView = {
  id: string;
  taskId: string;
  role: string;
  parts: JsonValue[];
  time: string | null;
};
export type A2AArtifactView = {
  id: string;
  taskId: string;
  name: string | null;
  description: string | null;
  parts: JsonValue[];
};
export type A2ATaskDetail = {
  summary: A2ATaskSummary;
  tree: A2ATaskNode[];
  messages: A2AMessageView[];
  artifacts: A2AArtifactView[];
  timeline: TimelineEntry[];
  protocol: {
    eventId: string;
    request?: JsonValue | null;
    response?: JsonValue | null;
    bodyState: BodyState;
  }[];
};
