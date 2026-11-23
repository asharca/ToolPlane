-- Per-member adjustments to workspace role default permissions.
ALTER TABLE "Membership" ADD COLUMN "grantedPermissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "revokedPermissions" TEXT[] DEFAULT ARRAY[]::TEXT[];
