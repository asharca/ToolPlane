import type { Metadata } from 'next';
import { ContentPage } from '@/components/ContentPage';

export const metadata: Metadata = { title: 'Terms | MCP Market' };

export default function Page() {
  return (
    <ContentPage title="Terms of Use">
      <p>
        This site is provided as-is for educational and demonstration purposes,
        with no warranties of any kind. It is a personal clone and not an
        official product.
      </p>
      <p>
        Trademarks, names, and content referenced here belong to their
        respective owners. Do not rely on this demo for production use.
      </p>
    </ContentPage>
  );
}
