BEGIN;

CREATE TYPE "WorkspaceAttachmentStatus" AS ENUM ('uploading', 'ready');

ALTER TABLE "User"
    ADD COLUMN "storageQuotaBytes" BIGINT,
    ADD COLUMN "maxOwnedWorkspaces" INTEGER;

ALTER TABLE "WorkspaceAttachment"
    ADD COLUMN "status" "WorkspaceAttachmentStatus" NOT NULL DEFAULT 'ready',
    ADD COLUMN "uploadStartedAt" TIMESTAMP(3);

-- Match ABSOLUTE_MAX_AGENT_ATTACHMENT_BYTES, including upload reservations.
ALTER TABLE "A2ATaskFile"
    DROP CONSTRAINT "A2ATaskFile_size_check",
    ADD CONSTRAINT "A2ATaskFile_size_check"
        CHECK ("size" IS NULL OR ("size" >= 0 AND "size" <= 2000000000));

CREATE INDEX "Workspace_ownerId_idx" ON "Workspace"("ownerId");
CREATE INDEX "WorkspaceAttachment_status_uploadStartedAt_idx"
    ON "WorkspaceAttachment"("status", "uploadStartedAt");

DO $$
DECLARE
    policy jsonb;
BEGIN
    SELECT "value"::jsonb INTO policy FROM "SystemSetting"
    WHERE "key" = 'transport.policy' FOR UPDATE;

    IF jsonb_typeof(policy) <> 'object' OR policy IS NULL THEN RETURN; END IF;

    IF policy ? 'a2aWorkspaceFileBytes' THEN
        INSERT INTO "SystemSetting" ("key", "value", "updatedAt")
        VALUES ('user.limits', jsonb_build_object(
            'storageQuotaBytes', policy->'a2aWorkspaceFileBytes',
            'maxOwnedWorkspaces', 3
        )::text, CURRENT_TIMESTAMP)
        ON CONFLICT ("key") DO NOTHING;
    END IF;

    UPDATE "SystemSetting"
    SET "value" = (policy - ARRAY['a2aFileBytes', 'a2aTaskInputBytes', 'a2aWorkspaceFileBytes'])::text,
        "updatedAt" = CURRENT_TIMESTAMP
    WHERE "key" = 'transport.policy';
EXCEPTION WHEN data_exception THEN
    -- An unreadable legacy policy already falls back to defaults at runtime.
    NULL;
END;
$$;

COMMIT;
