import type { Metadata } from 'next';
import { ContentPage } from '@/components/theme/ContentPage';

export const metadata: Metadata = { title: 'Sell Skills | ToolPlane' };

export default function Page() {
  return (
    <ContentPage title="Sell Your Agent Skills">
      <p>
        List your agent skills in the marketplace and reach developers building
        with the Model Context Protocol.
      </p>
      <p>The seller workflow is planned but not yet wired up.</p>
    </ContentPage>
  );
}
