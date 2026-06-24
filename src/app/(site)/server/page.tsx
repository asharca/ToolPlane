import { ServerList } from '@/components/server/ServerList';

export const dynamic = 'force-dynamic';

export default function Page() {
  return <ServerList page={1} />;
}
