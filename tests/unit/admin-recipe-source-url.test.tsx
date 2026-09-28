import { fireEvent, render, screen } from '@testing-library/react';
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
  it('preserves connector configuration and changes submitted auth fields with the selected mode', async () => {
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

    expect(screen.getByRole('textbox', { name: 'Connector endpoint URL' })).toHaveValue(
      'https://mcp.example.com/mcp',
    );
    expect(screen.getByRole('textbox', {
      name: 'Header to environment key mappings (Header-Name=ENV_KEY per line)',
    })).toHaveValue('X-API-Key=MCP_API_KEY');
    expect(screen.getByRole('textbox', { name: 'Source URL' })).toHaveValue(
      'https://github.com/acme/catalog-mcp',
    );
    fireEvent.click(screen.getByRole('combobox', { name: 'Authentication' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Bearer token' }));
    expect(screen.queryByRole('textbox', { name: 'Header to environment key mappings (Header-Name=ENV_KEY per line)' })).toBeNull();
    fireEvent.change(screen.getByRole('textbox', { name: 'Bearer token environment key' }), { target: { value: 'API_SECRET' } });
    const sourceUrl = screen.getByRole('textbox', { name: 'Source URL' }) as HTMLInputElement;
    const data = new FormData(sourceUrl.form!);
    expect(data.get('recipeAuthType')).toBe('bearer');
    expect(data.get('recipeBearerEnv')).toBe('API_SECRET');
    expect(data.has('recipeHeaderEnv')).toBe(false);
  });
});
