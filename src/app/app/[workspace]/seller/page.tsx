import { redirect } from 'next/navigation';

export default async function SellerRedirect({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace: slug } = await params;
  redirect(`/app/${slug}/seller/overview`);
}
