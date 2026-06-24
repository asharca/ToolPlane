import { DashboardHeader } from '@/components/dashboard/DashboardHeader';

export const dynamic = 'force-dynamic';

export default function Page() {
  return (
    <>
      <DashboardHeader title="Toolkits" />
      <div className="px-8 py-6">
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-zinc-200 py-20 text-center">
          <p className="text-sm text-zinc-500">No toolkits configured yet.</p>
        </div>
      </div>
    </>
  );
}
