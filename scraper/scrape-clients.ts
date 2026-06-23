import 'dotenv/config';
import { enumerateClients } from './enumerate';
import { upsertClient, setCheckpoint } from './ingest';
import { closeBrowser } from './browser';

async function main(): Promise<void> {
  try {
    const cards = await enumerateClients();
    for (const card of cards) await upsertClient(card);
    await setCheckpoint('clients', cards[cards.length - 1]?.slug ?? '', cards.length);
    console.log(`clients: upserted ${cards.length}`);
  } finally {
    await closeBrowser();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
