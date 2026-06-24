import type { Metadata } from 'next';
import { ContentPage } from '@/components/ContentPage';

export const metadata: Metadata = { title: 'Submit | MCP Market' };

export default function Page() {
  return (
    <ContentPage title="Submit an MCP Server">
      <p>
        Know a great MCP server that should be listed? Community submissions
        help others discover new tools and capabilities.
      </p>
      <p>This is a demo clone; the submission form is not yet active.</p>
    </ContentPage>
  );
}
