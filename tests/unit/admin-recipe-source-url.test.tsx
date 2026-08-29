import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/admin/market-actions', () => ({
  setServerRecipeAction: vi.fn(),
  removeServerRecipeAction: vi.fn(),
  validateServerRecipeAction: vi.fn(),
}));
vi.mock('@/components/dashboard/SubmitButton', () => ({
  SubmitButton: ({ children }: { children: React.ReactNode }) => <button type="submit">{children}</button>,
}));
vi.mock('@/components/admin/ConfirmDialog', () => ({ ConfirmDialog: () => null }));

import { RecipeEditor } from '@/components/admin/RecipeEditor';

describe('RecipeEditor source URL', () => {
  it('shows a persisted connector recipe and its source URL', () => {
    render(<RecipeEditor
      serverId="server-1"
      hasRecipe
      initial={{
        source: 'remote',
        ref: 'https://mcp.example.com/mcp',
        sourceUrl: 'https://github.com/acme/catalog-mcp',
        startCommand: '',
        env: '',
        envValues: '',
        network: false,
        transport: 'sse',
        authType: 'headers',
        headerEnv: 'X-API-Key=MCP_API_KEY',
      }}
      verifiedAt={null}
      verifiedTools={null}
    />);

    expect(screen.getByRole('combobox', { name: 'Source' })).toHaveValue('remote');
    expect(screen.getByRole('textbox', { name: 'Connector endpoint URL' })).toHaveValue(
      'https://mcp.example.com/mcp',
    );
    expect(screen.getByRole('combobox', { name: 'Transport' })).toHaveValue('sse');
    expect(screen.getByRole('combobox', { name: 'Authentication' })).toHaveValue('headers');
    expect(screen.getByRole('textbox', {
      name: 'Header to environment key mappings (Header-Name=ENV_KEY per line)',
    })).toHaveValue('X-API-Key=MCP_API_KEY');
    expect(screen.getByRole('textbox', { name: 'Source URL' })).toHaveAttribute(
      'name',
      'recipeSourceUrl',
    );
    expect(screen.getByRole('textbox', { name: 'Source URL' })).toHaveValue(
      'https://github.com/acme/catalog-mcp',
    );
  });
});
