import type { Metadata } from 'next';
import { ContentPage } from '@/components/theme/ContentPage';

export const metadata: Metadata = { title: 'Terms | ToolPlane' };

export default function Page() {
  return (
    <ContentPage title="Terms of Use">
      <p>
        ToolPlane is provided as-is, with no warranties of any kind. Use it only
        in environments where you control the deployed MCP servers, connectors,
        and sandbox runtimes.
      </p>
      <p>
        Trademarks, package names, and third-party content referenced here belong
        to their respective owners.
      </p>
    </ContentPage>
  );
}
