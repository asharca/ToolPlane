import { cache } from 'react';
import { publicDocs } from '../../.source/server';
import type { Doc } from './docs-links';

export const getDocs = cache(async (): Promise<Doc[]> => Promise.all(
  publicDocs.map(async ({ file, topic, category, title, language, slug, url, getText }) => ({
    file, topic, category, title, language, slug, url,
    content: await getText('processed'),
  })),
));
