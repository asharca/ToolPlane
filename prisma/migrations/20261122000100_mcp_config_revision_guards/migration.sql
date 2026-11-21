-- Configuration history is append-only. The owner can delete the deployment
-- (including its revisions) but cannot activate any other deployment's recipe.
CREATE TRIGGER "McpConfigRevision_immutable"
BEFORE UPDATE ON "McpConfigRevision" FOR EACH ROW
EXECUTE FUNCTION capability_revision_immutable();

ALTER TABLE "McpConfigRevision" ADD CONSTRAINT "McpConfigRevision_deployment_owner"
    UNIQUE ("deploymentId", "id");
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_active_mcp_config_owner"
    FOREIGN KEY ("id", "activeRevisionId") REFERENCES "McpConfigRevision" ("deploymentId", "id")
    DEFERRABLE INITIALLY DEFERRED;
