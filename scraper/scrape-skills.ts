import 'dotenv/config';
import { enumerateSkills } from './enumerate';
import { upsertSkill, setCheckpoint } from './ingest';
import { closeBrowser } from './browser';

async function main(): Promise<void> {
  try {
    const cards = await enumerateSkills();
    for (const card of cards) await upsertSkill(card);
    await setCheckpoint('skills', cards[cards.length - 1]?.slug ?? '', cards.length);
    console.log(`skills: upserted ${cards.length}`);
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
