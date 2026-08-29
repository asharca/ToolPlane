INSERT INTO "Category" ("id", "slug", "name") VALUES
  ('market-category-files', 'files', 'Files'),
  ('market-category-web', 'web', 'Web'),
  ('market-category-search', 'search', 'Search'),
  ('market-category-developer-tools', 'developer-tools', 'Developer Tools'),
  ('market-category-memory', 'memory', 'Memory'),
  ('market-category-reasoning', 'reasoning', 'Reasoning'),
  ('market-category-productivity', 'productivity', 'Productivity'),
  ('market-category-databases', 'databases', 'Databases'),
  ('market-category-communication', 'communication', 'Communication'),
  ('market-category-browser-automation', 'browser-automation', 'Browser Automation'),
  ('market-category-testing', 'testing', 'Testing'),
  ('market-category-security', 'security', 'Security'),
  ('market-category-observability', 'observability', 'Observability'),
  ('market-category-design', 'design', 'Design'),
  ('market-category-deployment', 'deployment', 'Deployment'),
  ('market-category-documents', 'documents', 'Documents'),
  ('market-category-research', 'research', 'Research'),
  ('market-category-data-analysis', 'data-analysis', 'Data Analysis'),
  ('market-category-operations', 'operations', 'Operations')
ON CONFLICT ("slug") DO UPDATE SET "name" = EXCLUDED."name";

INSERT INTO "_ServerCategories" ("A", "B")
SELECT category."id", server."id"
FROM (VALUES
  ('smoke-catalog-memory', 'memory'),
  ('smoke-catalog-memory', 'productivity'),
  ('smoke-catalog-sequential-thinking', 'reasoning'),
  ('smoke-catalog-sequential-thinking', 'productivity'),
  ('smoke-catalog-fetch', 'web'),
  ('smoke-catalog-fetch', 'search'),
  ('smoke-catalog-time', 'productivity'),
  ('smoke-catalog-filesystem', 'files'),
  ('smoke-catalog-filesystem', 'developer-tools')
) AS seed("resourceSlug", "categorySlug")
JOIN "Server" AS server ON server."slug" = seed."resourceSlug"
JOIN "Category" AS category ON category."slug" = seed."categorySlug"
ON CONFLICT DO NOTHING;

INSERT INTO "_SkillCategories" ("A", "B")
SELECT category."id", skill."id"
FROM (VALUES
  ('smoke-catalog-code-review', 'developer-tools'),
  ('smoke-catalog-code-review', 'testing'),
  ('smoke-catalog-code-review', 'security'),
  ('smoke-catalog-web-research', 'research'),
  ('smoke-catalog-web-research', 'web'),
  ('smoke-catalog-web-research', 'search'),
  ('smoke-catalog-incident-triage', 'operations'),
  ('smoke-catalog-incident-triage', 'observability'),
  ('smoke-catalog-release-notes', 'developer-tools'),
  ('smoke-catalog-release-notes', 'deployment'),
  ('smoke-catalog-release-notes', 'documents'),
  ('smoke-catalog-data-analysis', 'data-analysis'),
  ('smoke-catalog-data-analysis', 'reasoning')
) AS seed("resourceSlug", "categorySlug")
JOIN "Skill" AS skill ON skill."slug" = seed."resourceSlug"
JOIN "Category" AS category ON category."slug" = seed."categorySlug"
ON CONFLICT DO NOTHING;

INSERT INTO "_AgentListingCategories" ("A", "B")
SELECT listing."id", category."id"
FROM (VALUES
  ('smoke-research-copilot', 'research'),
  ('smoke-research-copilot', 'productivity'),
  ('smoke-hermes-operator', 'operations'),
  ('smoke-hermes-operator', 'productivity'),
  ('smoke-code-quality-guardian', 'developer-tools'),
  ('smoke-code-quality-guardian', 'testing'),
  ('smoke-code-quality-guardian', 'security'),
  ('smoke-incident-response-lead', 'operations'),
  ('smoke-incident-response-lead', 'observability')
) AS seed("resourceSlug", "categorySlug")
JOIN "AgentListing" AS listing ON listing."directorySlug" = seed."resourceSlug"
JOIN "Category" AS category ON category."slug" = seed."categorySlug"
ON CONFLICT DO NOTHING;

INSERT INTO "_MarketListingCategories" ("A", "B")
SELECT category."id", listing."id"
FROM "MarketListing" AS listing
JOIN "Category" AS category ON category."slug" = ANY(listing."tags")
ON CONFLICT DO NOTHING;

INSERT INTO "_ToolkitCategories" ("A", "B")
SELECT category."id", toolkit."id"
FROM (VALUES
  ('developer-essentials', 'developer-tools'),
  ('developer-essentials', 'productivity'),
  ('research-desk', 'research'),
  ('research-desk', 'web'),
  ('research-desk', 'search')
) AS seed("resourceSlug", "categorySlug")
JOIN "Toolkit" AS toolkit ON toolkit."slug" = seed."resourceSlug" AND toolkit."visibility" = 'public'
JOIN "Category" AS category ON category."slug" = seed."categorySlug"
ON CONFLICT DO NOTHING;
