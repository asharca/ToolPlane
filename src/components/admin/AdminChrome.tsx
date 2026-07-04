import type { ReactNode } from 'react';
import { AdminSidebar } from './AdminSidebar';

export function AdminChrome({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh bg-background text-foreground">
      <AdminSidebar />
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
