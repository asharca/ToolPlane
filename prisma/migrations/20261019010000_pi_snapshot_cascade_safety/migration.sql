-- Protect referenced artifacts at statement completion while allowing workspace/session cascades.
ALTER TABLE "PiSessionPackage" DROP CONSTRAINT "PiSessionPackage_marketInstallId_fkey";
ALTER TABLE "PiSessionPackage" ADD CONSTRAINT "PiSessionPackage_marketInstallId_fkey"
  FOREIGN KEY ("marketInstallId") REFERENCES "MarketInstall"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "PiSessionPackage" DROP CONSTRAINT "PiSessionPackage_releaseId_fkey";
ALTER TABLE "PiSessionPackage" ADD CONSTRAINT "PiSessionPackage_releaseId_fkey"
  FOREIGN KEY ("releaseId") REFERENCES "MarketRelease"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
