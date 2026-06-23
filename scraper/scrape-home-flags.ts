import 'dotenv/config';
import { fetchRenderedHtml, closeBrowser } from './browser';
import { parseHomeFlagged } from './parse';
import { upsertServer } from './ingest';
import { db } from '@/lib/db';

async function main(): Promise<void> {
  try {
    const html = await fetchRenderedHtml('/', 'a[href^="/server/"] h3');
    const { official, featured } = parseHomeFlagged(html);

    for (const card of official) {
      await upsertServer(card);
      await db.server.update({
        where: { slug: card.slug },
        data: { isOfficial: true },
      });
    }
    for (const card of featured) {
      await upsertServer(card);
      await db.server.update({
        where: { slug: card.slug },
        data: { isFeatured: true },
      });
    }

    console.log(
      `flagged official ${official.length}, featured ${featured.length}`,
    );
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
