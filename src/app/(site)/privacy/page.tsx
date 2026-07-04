import type { Metadata } from 'next';
import { ContentPage } from '@/components/theme/ContentPage';

export const metadata: Metadata = { title: 'Privacy | ToolPlane' };

export default function Page() {
  return (
    <ContentPage title="Privacy Policy">
      <p>
        ToolPlane stores the account, workspace, runtime, and observability data
        needed to operate agent toolchains. It does not use advertising cookies
        or third-party tracking.
      </p>
    </ContentPage>
  );
}
