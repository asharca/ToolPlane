'use client';

import { ApiReferenceReact } from '@scalar/api-reference-react';
import { useTheme } from 'next-themes';
import '@scalar/api-reference-react/style.css';

export function Reference() {
  const { resolvedTheme } = useTheme();
  return <ApiReferenceReact configuration={{
    url: '/api/v1/openapi.json',
    darkMode: resolvedTheme === 'dark',
    hideDarkModeToggle: true,
    withDefaultFonts: false,
    persistAuth: false,
    hideClientButton: true,
    agent: { disabled: true },
    mcp: { disabled: true },
    showDeveloperTools: 'never',
    hideTestRequestButton: false,
  }} />;
}
