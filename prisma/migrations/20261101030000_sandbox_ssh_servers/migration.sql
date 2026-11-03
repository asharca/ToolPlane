-- CreateTable
CREATE TABLE "SandboxSshServer" (
    "sandboxId" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL DEFAULT 22,
    "username" TEXT NOT NULL,
    "root" TEXT NOT NULL,
    "hostKeys" JSONB NOT NULL,
    "authType" TEXT NOT NULL,
    "encryptedSecret" JSONB NOT NULL,
    "encryptedPassphrase" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SandboxSshServer_pkey" PRIMARY KEY ("sandboxId"),
    CONSTRAINT "SandboxSshServer_authType_check" CHECK ("authType" IN ('key', 'password')),
    CONSTRAINT "SandboxSshServer_port_check" CHECK ("port" BETWEEN 1 AND 65535),
    CONSTRAINT "SandboxSshServer_passphrase_check" CHECK ("authType" = 'key' OR "encryptedPassphrase" IS NULL)
);

-- AddForeignKey
ALTER TABLE "SandboxSshServer" ADD CONSTRAINT "SandboxSshServer_sandboxId_fkey" FOREIGN KEY ("sandboxId") REFERENCES "Sandbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Administrator target-file SSH sandboxes carry no stored credentials; they
-- stay listed as legacy (not startable) until deleted and re-added by a user.
