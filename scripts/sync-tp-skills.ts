import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { defaultTpSkillsSource, syncGithubSkillRegistry } from '@/lib/skills/registry';

function createClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL environment variable is not set.');
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

async function main() {
  const db = createClient();
  try {
    const source = defaultTpSkillsSource();
    console.log(`Syncing ${source.owner}/${source.repo}@${source.ref}/${source.rootPath}...`);
    const result = await syncGithubSkillRegistry(db, source);
    console.log(
      `Found ${result.found}; created ${result.created}; updated ${result.updated}; failed ${result.failed.length}.`,
    );
    if (result.commitSha) console.log(`Commit ${result.commitSha}`);
    for (const failure of result.failed) {
      console.warn(`failed ${failure.path}: ${failure.error}`);
    }
    if (result.failed.length > 0) process.exitCode = 1;
  } finally {
    await db.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
