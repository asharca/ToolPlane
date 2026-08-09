'use client';

import { createContext, useContext, type ReactNode } from 'react';
import { SITE } from '@/lib/site';

type DashboardRuntimeConfigValue = { supportEmail: string };

const DashboardRuntimeConfigContext = createContext<DashboardRuntimeConfigValue>({
  supportEmail: SITE.supportEmail,
});

export function DashboardRuntimeConfigProvider({
  supportEmail,
  children,
}: DashboardRuntimeConfigValue & { children: ReactNode }) {
  return (
    <DashboardRuntimeConfigContext.Provider value={{ supportEmail }}>
      {children}
    </DashboardRuntimeConfigContext.Provider>
  );
}

export function useDashboardRuntimeConfig(): DashboardRuntimeConfigValue {
  return useContext(DashboardRuntimeConfigContext);
}
