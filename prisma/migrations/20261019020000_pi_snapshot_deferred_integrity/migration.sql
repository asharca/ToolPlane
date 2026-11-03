-- PostgreSQL cascade triggers can delete installs before their owning session sets.
-- Check artifact references only when the complete cascade transaction finishes.
ALTER TABLE "PiSessionPackage" ALTER CONSTRAINT "PiSessionPackage_marketInstallId_fkey" DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "PiSessionPackage" ALTER CONSTRAINT "PiSessionPackage_releaseId_fkey" DEFERRABLE INITIALLY DEFERRED;
