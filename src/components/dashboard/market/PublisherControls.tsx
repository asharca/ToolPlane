import { EyeOff, Undo2 } from 'lucide-react';
import { ConfirmSubmitButton } from '@/components/dashboard/ConfirmSubmitButton';
import { unpublishMarketListingAction, withdrawMarketReleaseAction } from '@/lib/market/actions';

export type ListingStatus = {
  id?: string;
  status: string;
  latestVersion: number;
  latestRelease: { version: number } | null;
  pendingRelease: { version: number; reviewStatus: string } | null;
};

export function PublisherControls({ listing, workspace, canPublish, labels }: {
  listing: ListingStatus | undefined;
  workspace: string;
  canPublish: boolean;
  labels: { withdraw: string; withdrawing: string; withdrawConfirm: string; unpublish: string; unpublishing: string; unpublishConfirm: string; cancel: string };
}) {
  if (!listing?.id || !canPublish) return null;
  return <div className="flex flex-wrap justify-end gap-2 sm:col-span-4">
    {listing.pendingRelease?.reviewStatus === 'pending' ? <form action={withdrawMarketReleaseAction}>
      <input type="hidden" name="workspace" value={workspace} />
      <input type="hidden" name="listingId" value={listing.id} />
      <ConfirmSubmitButton triggerLabel={<><Undo2 className="size-3.5" />{labels.withdraw}</>} prompt={labels.withdrawConfirm} confirmLabel={labels.withdraw} pendingLabel={labels.withdrawing} cancelLabel={labels.cancel} promptClassName="max-w-72 text-xs text-muted-foreground" />
    </form> : null}
    {listing.status === 'published' && listing.latestRelease ? <form action={unpublishMarketListingAction}>
      <input type="hidden" name="workspace" value={workspace} />
      <input type="hidden" name="listingId" value={listing.id} />
      <ConfirmSubmitButton triggerLabel={<><EyeOff className="size-3.5" />{labels.unpublish}</>} prompt={labels.unpublishConfirm} confirmLabel={labels.unpublish} pendingLabel={labels.unpublishing} cancelLabel={labels.cancel} promptClassName="max-w-72 text-xs text-muted-foreground" />
    </form> : null}
  </div>;
}
