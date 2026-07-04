import type { Metadata } from 'next';
import { ContentPage } from '@/components/theme/ContentPage';

export const metadata: Metadata = { title: 'Submit | ToolPlane' };

export default function Page() {
  return (
    <ContentPage title="Submit an MCP Server">
      <p>
        Know a great MCP server that should be listed? Community submissions
        help others discover new tools and capabilities.
      </p>
      <p>The submission workflow is planned but not yet active.</p>
    </ContentPage>
  );
}
