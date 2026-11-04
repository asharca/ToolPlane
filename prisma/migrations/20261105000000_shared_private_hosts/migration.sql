-- One atomic cutover: block concurrent setting writes while taking the legacy
-- snapshot, preserve an existing shared policy, then retire the old keys.
DO $$
BEGIN
  LOCK TABLE "SystemSetting" IN SHARE ROW EXCLUSIVE MODE;

  WITH legacy AS (
    SELECT "key", "value"
    FROM "SystemSetting"
    WHERE "key" IN ('mcp.remotePrivateHosts', 'sandboxes.sshPrivateHosts')
  ), entries AS (
    SELECT DISTINCT regexp_replace(
      regexp_replace(lower(btrim(entry, E' \t\n\r\f\013')), '^\[|\]$', '', 'g'),
      '\.$', ''
    ) AS host
    FROM legacy, LATERAL regexp_split_to_table("value", E'[\r\n,]') AS entry
  )
  INSERT INTO "SystemSetting" ("key", "value", "updatedAt")
  SELECT
    'network.privateHosts',
    COALESCE(
      -- Never turn an over-limit corrupt policy into a valid grant by trimming
      -- or deduplicating it. Other invalid tokens remain in the union and are
      -- rejected by the runtime parser, rather than silently being discarded.
      (SELECT "value" FROM legacy WHERE char_length("value") > 8192 ORDER BY "key" LIMIT 1),
      (SELECT string_agg(host, ',' ORDER BY host COLLATE "C") FROM entries WHERE host <> ''),
      ''
    ),
    CURRENT_TIMESTAMP
  WHERE EXISTS (SELECT 1 FROM legacy)
  ON CONFLICT ("key") DO NOTHING;

  DELETE FROM "SystemSetting"
  WHERE "key" IN ('mcp.remotePrivateHosts', 'sandboxes.sshPrivateHosts');
END;
$$;
