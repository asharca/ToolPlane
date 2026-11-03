import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

async function main() {
  // Static import initializes the runtime DB singleton outside this CLI's
  // sanitized error boundary; configuration failures must not print raw errors.
  const { migrateMcpCredentials, parseMcpMigrationArguments } = await import(
    "./lib/mcp-credential-migration"
  );
  const options = parseMcpMigrationArguments(process.argv.slice(2));
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString || !process.env.AUTH_SECRET) {
    throw new Error("MCP_MIGRATION_ENVIRONMENT_REQUIRED");
  }
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  try {
    const result = await db.$transaction(
      (tx) => migrateMcpCredentials(tx, options),
      { isolationLevel: "Serializable", timeout: 120_000 },
    );
    // Counts only: never log configs, identifiers, ciphertext, hashes or errors.
    console.log(JSON.stringify(result));
  } finally {
    await db.$disconnect();
  }
}

main().catch(() => {
  console.error(
    "MCP credential migration refused or failed; no batch committed. Confirm --workspace ID, stopped deployments, DATABASE_URL and AUTH_SECRET. Re-run dry-run after resolving configuration or concurrent changes.",
  );
  process.exitCode = 1;
});
