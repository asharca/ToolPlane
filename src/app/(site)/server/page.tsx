import type { Metadata } from 'next';
import { ServerList } from '@/components/server/ServerList';
import { capabilityMetadata } from '../_lib/metadata';

export function generateMetadata(): Promise<Metadata> {
  return capabilityMetadata('mcp', '/server');
}

export default function Page() {
  return <ServerList page={1} />;
}
