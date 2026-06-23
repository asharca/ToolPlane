import type { Metadata } from 'next';
import { ContentPage } from '@/components/ContentPage';

export const metadata: Metadata = { title: 'Privacy | MCP Market' };

export default function Page() {
  return (
    <ContentPage title="Privacy Policy">
      <p>
        This site is a personal, non-commercial clone of MCP Market built for
        learning purposes. It is not affiliated with, endorsed by, or connected
        to mcpmarket.com.
      </p>
      <p>
        The application does not collect personal data, set advertising
        cookies, or use third-party tracking. Catalog data shown here was
        gathered for local development and demonstration only.
      </p>
    </ContentPage>
  );
}
