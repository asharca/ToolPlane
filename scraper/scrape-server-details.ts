import 'dotenv/config';
import { db } from '@/lib/db';
import { fetchServerDetail } from './fetch-detail';
import { enrichServer } from './ingest';
import { closeBrowser } from './browser';
import { sleep } from './rate-limit';

async function main(): Promise<void> {
  const limit = Number(process.argv[2] ?? 0); // 0 = all
  try {
    const servers = await db.server.findMany({
      select: { slug: true },
      orderBy: { stars: 'desc' },
      ...(limit ? { take: limit } : {}),
    });
    let done = 0;
    for (const { slug } of servers) {
      try {
        const detail = await fetchServerDetail(slug);
        await enrichServer(slug, detail);
        done += 1;
        if (done % 20 === 0) console.log(`enriched ${done}/${servers.length}`);
      } catch (err) {
        console.warn(`skip ${slug}: ${String(err)}`);
      }
      await sleep(800);
    }
    console.log(`enriched ${done}/${servers.length} servers`);
  } finally {
    await closeBrowser();
    await db.$disconnect();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
