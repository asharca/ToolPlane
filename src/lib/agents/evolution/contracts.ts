import type { AgentRevisionConfig } from "@/lib/agents/revision-types";

/** Browser-safe contracts. Never includes runtime credentials or exception text. */
export type EvolutionErrorCode =
  | "UNAUTHORIZED"
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "INVALID_REQUEST"
  | "CONFLICT"
  | "BUDGET_EXCEEDED"
  | "MODEL_PRICING_UNAVAILABLE"
  | "RUNTIME_UNAVAILABLE"
  | "EVOLUTION_FAILED";
export interface RecordedEvolutionTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  calls: Array<{
    arguments: Record<string, unknown>;
    result: unknown;
    isError: boolean;
  }>;
}
export interface RolloutMetricsDto {
  tasks: number;
  succeeded: number;
  failed: number;
  toolCalls: number;
  toolFailures: number;
  averageCostMicros: string;
  feedbackPositive: number;
  feedbackNegative: number;
  successRate: number | null;
}
export type EvolutionScope =
  | { kind: "agent" }
  | { kind: "conversation"; conversationId: string }
  | { kind: "task"; taskId: string };
export interface EvolutionSettingsDto {
  enabled: boolean;
  reflectionEnabled: boolean;
  reflectionIntervalHours: number;
  nextReflectionAt: string | null;
  monthlyBudgetMicros: string;
  spentMicros: string;
}
export interface FeedbackDto {
  id: string;
  messageId: string;
  conversationId: string;
  rating: "positive" | "negative";
  comment: string;
  createdById: string;
  createdAt: string;
  updatedAt: string;
}
export interface EpisodeDto {
  toolCalls?: number;
  toolFailures?: number;
  id: string;
  taskId: string | null;
  conversationId: string | null;
  revisionId: string | null;
  outcome: "succeeded" | "failed" | "canceled";
  summary: string;
  failureCode: string | null;
  inputTokens: number;
  outputTokens: number;
  costMicros: string;
  createdAt: string;
}
export interface PlaybookDto {
  id: string;
  version: number;
  scope: EvolutionScope;
  content: string;
  status: "pending" | "approved" | "rejected" | "archived";
  reviewedById: string | null;
  createdAt: string;
}
export interface ReflectionDto {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed";
  failureCode: string | null;
  costMicros: string;
  createdAt: string;
  completedAt: string | null;
}
export interface ProposalDto {
  id: string;
  kind: "prompt" | "skill";
  title: string;
  rationale: string;
  status: "pending" | "approved" | "rejected";
  baseRevisionId: string;
  candidateRevisionId: string | null;
  createdAt: string;
  reviewedById: string | null;
}
export interface ProposalDetailDto extends ProposalDto {
  newSkill?: {
    name: string;
    description: string;
    markdown: string;
    files: Array<{ path: string; content: string; encoding?: "base64" }>;
  } | null;
  evidence?: { episodeIds: string[]; feedbackIds: string[] };
  before: AgentRevisionConfig;
  after: AgentRevisionConfig;
}
export interface EvolutionCaseDto {
  recordedTools?: RecordedEvolutionTool[];
  requiredTools?: string[];
  criterion?: "exact" | "contains" | "rubric";
  id: string;
  name: string;
  input: string;
  expected: string;
  createdAt: string;
}
export interface EvaluationResultDto {
  executionImageId?: string;
  judgeCostMicros?: string;
  id: string;
  caseId: string;
  variant: "baseline" | "candidate";
  output: string;
  quality: number;
  costMicros: string;
  inputTokens: number;
  outputTokens: number;
  failureCode: string | null;
}
export interface EvaluationDto {
  excludedCapabilities?: string[];
  id: string;
  proposalId: string;
  status: "queued" | "running" | "succeeded" | "failed";
  failureCode: string | null;
  baselineRevisionId: string;
  candidateRevisionId: string;
  pareto:
    | "candidate_dominates"
    | "baseline_dominates"
    | "tradeoff"
    | "equal"
    | null;
  createdAt: string;
  completedAt: string | null;
  results: EvaluationResultDto[];
}
export interface RolloutDto {
  metrics?: {
    baseline: RolloutMetricsDto;
    candidate: RolloutMetricsDto;
    sampleStatus: "insufficient" | "ready";
    recommendation: "collect_more" | "rollback" | "promote" | "review_tradeoff";
  };
  id: string;
  proposalId: string;
  baselineRevisionId: string;
  candidateRevisionId: string;
  percentage: number;
  status: "active" | "stopped" | "promoted" | "rolled_back";
  createdAt: string;
}
export interface EvolutionOverviewDto {
  settings: EvolutionSettingsDto;
  permissions: { canReview: boolean; canExecute: boolean };
  reflections: ReflectionDto[];
}
export type EvolutionResponse<T> =
  | { data: T }
  | { error: { code: EvolutionErrorCode; message: string } };
export const EVOLUTION_ENDPOINTS = {
  settings: { methods: ["GET", "PUT"] },
  episodes: { methods: ["GET"] },
  feedback: { methods: ["GET"] },
  playbook: { methods: ["GET", "POST", "PATCH"] },
  proposals: { methods: ["GET", "POST", "PATCH"] },
  cases: { methods: ["GET", "POST", "PATCH", "DELETE"] },
  evaluations: { methods: ["GET", "POST"] },
  rollout: { methods: ["GET", "POST", "PATCH"] },
  reflections: { methods: ["GET", "POST"] },
} as const;
