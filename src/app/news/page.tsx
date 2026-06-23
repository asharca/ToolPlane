import type { Metadata } from 'next';
import { ContentPage } from '@/components/ContentPage';

export const metadata: Metadata = { title: 'News | MCP Market' };

export default function Page() {
  return (
    <ContentPage title="News">
      <p>The latest updates from the MCP ecosystem.</p>
      <p>No articles yet.</p>
    </ContentPage>
  );
}
