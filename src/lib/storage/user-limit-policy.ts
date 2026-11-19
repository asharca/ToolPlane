export const GiB = 1024 ** 3;
export const DEFAULT_USER_LIMITS = {
  storageQuotaBytes: GiB,
  maxOwnedWorkspaces: 3,
} as const;
export const USER_LIMIT_RANGES = {
  storageQuotaBytes: [GiB, 1024 * GiB],
  maxOwnedWorkspaces: [1, 100],
} as const;
export type UserLimits = {
  storageQuotaBytes: number;
  maxOwnedWorkspaces: number;
};
