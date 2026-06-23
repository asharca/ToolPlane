import 'dotenv/config';
import { enumerateServerPage } from './enumerate';
import { upsertServer, setCheckpoint } from './ingest';
import { sleep } from './rate-limit';

const PAGE_DELAY_MS = 1000;

async function main(): Promise<void> {
  const maxPages = Number(process.argv[2] ?? process.env.SCRAPE_PAGES ?? 2);
  let done = 0;

  for (let page = 1; page <= maxPages; page++) {
    const cards = await enumerateServerPage(page);
    if (cards.length === 0) {
      console.log(`page ${page}: no cards, stopping`);
      break;
    }
    for (const card of cards) {
      await upsertServer(card);
      done += 1;
    }
    await setCheckpoint('servers', cards[cards.length - 1]?.slug ?? '', done);
    console.log(`page ${page}: upserted ${cards.length} (total ${done})`);
    if (page < maxPages) await sleep(PAGE_DELAY_MS);
  }

  console.log(`done: ${done} servers`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
