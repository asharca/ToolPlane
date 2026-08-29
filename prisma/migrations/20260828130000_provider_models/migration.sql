CREATE TABLE "ProviderModel" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "group" TEXT NOT NULL DEFAULT '',
    "primaryType" TEXT NOT NULL DEFAULT 'text',
    "capabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "inputModalities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "contextWindow" INTEGER,
    "maxInputTokens" INTEGER,
    "maxOutputTokens" INTEGER,
    "source" TEXT NOT NULL DEFAULT 'remote',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderModel_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProviderModel_providerId_modelId_key" ON "ProviderModel"("providerId", "modelId");
CREATE INDEX "ProviderModel_providerId_primaryType_idx" ON "ProviderModel"("providerId", "primaryType");

ALTER TABLE "ProviderModel"
ADD CONSTRAINT "ProviderModel_providerId_fkey"
FOREIGN KEY ("providerId") REFERENCES "ModelProvider"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "ProviderModel" (
    "id",
    "providerId",
    "modelId",
    "name",
    "group",
    "primaryType",
    "source",
    "updatedAt"
)
SELECT
    'pm_' || md5(provider."id" || ':' || model."modelId"),
    provider."id",
    model."modelId",
    model."modelId",
    CASE
      WHEN strpos(model."modelId", '/') > 0 THEN split_part(model."modelId", '/', 1)
      WHEN strpos(model."modelId", '-') > 0 THEN split_part(model."modelId", '-', 1)
      ELSE ''
    END,
    CASE
      WHEN lower(model."modelId") ~ '(rerank|reranker)' THEN 'rerank'
      WHEN lower(model."modelId") ~ '(embedding|embed|(^|[/_-])(bge|e5|gte)([/_-]|$))' THEN 'embedding'
      WHEN lower(model."modelId") ~ '(dall-e|gpt-image|imagen|stable-diffusion|sdxl|flux|cogview|kolors|ideogram|recraft)' THEN 'image'
      ELSE 'text'
    END,
    'remote',
    CURRENT_TIMESTAMP
FROM "ModelProvider" AS provider
CROSS JOIN LATERAL unnest(provider."models") AS model("modelId")
ON CONFLICT ("providerId", "modelId") DO NOTHING;
