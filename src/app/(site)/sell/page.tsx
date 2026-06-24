import type { Metadata } from 'next';
import { ContentPage } from '@/components/ContentPage';

export const metadata: Metadata = { title: 'Sell Skills | MCP Market' };

export default function Page() {
  return (
    <ContentPage title="Sell Your Agent Skills">
      <p>
        List your agent skills in the marketplace and reach developers building
        with the Model Context Protocol.
      </p>
      <p>This is a demo clone; the seller flow is not yet wired up.</p>
    </ContentPage>
  );
}
