BEGIN;

-- Delay the generated DROP until the encrypted envelopes have been copied.
ALTER TABLE "AgentTrigger" ADD COLUMN "connectionId" TEXT;

-- CreateTable
CREATE TABLE "AccountConnection" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "preset" TEXT NOT NULL,
    "authType" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "encryptedSecret" JSONB,
    "expiresAt" TIMESTAMP(3),
    "refreshLeaseUntil" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'pending',
    "accountLabel" TEXT,
    "lastError" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountConnectionOAuthPending" (
    "stateHash" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "encryptedVerifier" JSONB NOT NULL,
    "redirectUri" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountConnectionOAuthPending_pkey" PRIMARY KEY ("stateHash")
);

-- CreateIndex
CREATE INDEX "AccountConnection_workspaceId_idx" ON "AccountConnection"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AccountConnection_workspaceId_name_key" ON "AccountConnection"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "AccountConnectionOAuthPending_expiresAt_idx" ON "AccountConnectionOAuthPending"("expiresAt");

-- CreateIndex
CREATE INDEX "AgentTrigger_connectionId_idx" ON "AgentTrigger"("connectionId");

-- AddForeignKey
ALTER TABLE "AccountConnection" ADD CONSTRAINT "AccountConnection_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountConnectionOAuthPending" ADD CONSTRAINT "AccountConnectionOAuthPending_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "AccountConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentTrigger" ADD CONSTRAINT "AgentTrigger_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "AccountConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

DO $$
DECLARE
  t record;
  label text;
  base text;
  suffix integer;
  conn text;
  cfg jsonb;
  filters jsonb;
  reasons jsonb;
BEGIN
  FOR t IN SELECT * FROM "AgentTrigger" WHERE kind IN ('github','x','youtube') ORDER BY "createdAt", id LOOP
    IF t.kind = 'youtube' THEN
      UPDATE "AgentTriggerItem" SET "externalId" = 'yt:video:' || "externalId" WHERE "triggerId" = t.id;
      UPDATE "AgentTrigger" SET kind = 'feed', "sourceConfig" = jsonb_build_object('url',
        'https://www.youtube.com/feeds/videos.xml?channel_id=' || (t."sourceConfig"->>'channelId')) WHERE id = t.id;
      CONTINUE;
    END IF;
    base := left(t.name,77) || ' 令牌';
    label := base;
    suffix := 0;
    WHILE EXISTS (SELECT FROM "AccountConnection" WHERE "workspaceId" = t."workspaceId" AND name = label) LOOP
      label := left(base, CASE WHEN suffix = 0 THEN 73 ELSE 72 - length(suffix::text) END)
        || ' ' || right(t.id,6) || CASE WHEN suffix = 0 THEN '' ELSE '-' || suffix END;
      suffix := suffix + 1;
    END LOOP;
    conn := 'migrated-' || t.id;
    IF t.kind = 'github' THEN
      cfg := '{"allowedHosts":["api.github.com"],"testUrl":"https://api.github.com/user","accountPath":"login"}';
      reasons := coalesce(t."sourceConfig"->'reasons','["review_requested","mention"]'::jsonb);
      filters := '[]';
      IF jsonb_array_length(reasons) > 0 THEN
        filters := jsonb_build_array(jsonb_build_object('path','reason','values',reasons));
      ELSE
        UPDATE "AgentTrigger" SET enabled = false, "nextRunAt" = NULL WHERE id = t.id;
      END IF;
      IF jsonb_array_length(t."sourceConfig"->'repositories') > 0 THEN
        filters := filters || jsonb_build_array(jsonb_build_object('path','repository.full_name','values',t."sourceConfig"->'repositories'));
      END IF;
      UPDATE "AgentTrigger" SET "sourceConfig" = jsonb_build_object('url','https://api.github.com/notifications?participating=true&per_page=50',
        'itemsPath','','idPath','id','revisionPath','updated_at','filters',filters) WHERE id = t.id;
    ELSE
      cfg := '{"allowedHosts":["api.x.com"]}';
      UPDATE "AgentTrigger" SET "sourceConfig" = jsonb_build_object('url','https://api.x.com/2/users/' || (t."sourceConfig"->>'userId') ||
        '/mentions?tweet.fields=author_id,created_at&max_results=100','itemsPath','data','idPath','id') WHERE id = t.id;
    END IF;
    INSERT INTO "AccountConnection" (id,"workspaceId",name,preset,"authType",config,"encryptedSecret",status,"createdById","updatedAt")
      VALUES (conn,t."workspaceId",label,t.kind,'bearer',cfg,jsonb_build_object('value',t."sourceCredential"),'active',t."actorId",CURRENT_TIMESTAMP);
    UPDATE "AgentTrigger" SET kind = 'http', "connectionId" = conn WHERE id = t.id;
  END LOOP;
END $$;

ALTER TABLE "AgentTrigger" DROP COLUMN "sourceCredential";
COMMIT;

