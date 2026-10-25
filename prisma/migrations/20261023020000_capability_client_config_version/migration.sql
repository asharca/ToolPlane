-- Separate authorization configuration CAS from lastUsedAt / updatedAt writes.
-- Existing installations start at version zero without changing their selections.
ALTER TABLE "PiPackageClientInstallation"
  ADD COLUMN "configVersion" INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT "PiPackageClientInstallation_configVersion_nonnegative"
    CHECK ("configVersion" >= 0);

CREATE FUNCTION toolplane_guard_client_config_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."configVersion" <> OLD."configVersion" AND
     NEW."configVersion"::bigint <> OLD."configVersion"::bigint + 1 THEN
    RAISE EXCEPTION 'Client configuration version must advance by exactly one';
  END IF;
  IF (NEW."marketInstallId", NEW."releaseId", NEW.selections) IS DISTINCT FROM
     (OLD."marketInstallId", OLD."releaseId", OLD.selections) AND
     NEW."configVersion"::bigint <> OLD."configVersion"::bigint + 1 THEN
    RAISE EXCEPTION 'Reviewed client selection changes must advance configuration version';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "PiPackageClientInstallation_config_version"
  BEFORE UPDATE ON "PiPackageClientInstallation"
  FOR EACH ROW EXECUTE FUNCTION toolplane_guard_client_config_version();
