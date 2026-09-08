import { redirect } from 'next/navigation';
import { ACCOUNT_SETTINGS_HREF } from '@/lib/workspace/navigation';

// Keep old bookmarks working; personal tokens do not belong to a workspace.
export default function TokensPage() {
  redirect(ACCOUNT_SETTINGS_HREF);
}
