-- Optimize the Logs page's workspace + deployment + time-window query.
CREATE INDEX "RequestLog_workspaceId_deploymentId_createdAt_idx"
ON "RequestLog"("workspaceId", "deploymentId", "createdAt");
