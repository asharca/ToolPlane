import type { EvolutionErrorCode } from "./contracts";
export class EvolutionError extends Error {
  constructor(public readonly code: EvolutionErrorCode) {
    super(code);
  }
}
export const evolutionErrorStatus: Record<EvolutionErrorCode, number> = {
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  INVALID_REQUEST: 400,
  CONFLICT: 409,
  BUDGET_EXCEEDED: 402,
  MODEL_PRICING_UNAVAILABLE: 422,
  RUNTIME_UNAVAILABLE: 503,
  EVOLUTION_FAILED: 500,
};
