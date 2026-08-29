import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ fetchMetadata: vi.fn() }));

vi.mock('@/lib/admin/market-actions', () => ({
  fetchServerSourceMetadataAction: mocks.fetchMetadata,
}));
vi.mock('@/components/dashboard/SubmitButton', () => ({
  SubmitButton: ({ children }: { children: React.ReactNode }) => <button type="submit">{children}</button>,
}));

import { ServerForm } from '@/components/admin/ServerForm';

describe('ServerForm source metadata', () => {
  it('can fetch package metadata and keeps the canonical source URL for saving', () => {
    render(<ServerForm
      action={vi.fn().mockResolvedValue({})}
      initial={{ sourceUrl: 'https://github.com/acme/catalog-mcp' }}
      categories={[]}
      submitLabel="Create"
    />);

    expect(screen.getByRole('combobox', { name: 'Metadata source' })).toHaveAttribute(
      'name',
      'sourceMetadataSource',
    );
    expect(screen.getByRole('textbox', { name: 'Package or GitHub repository' })).toHaveAttribute(
      'name',
      'sourceMetadataRef',
    );
    expect(screen.getByRole('button', { name: 'Fetch metadata' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Source URL' })).toHaveValue(
      'https://github.com/acme/catalog-mcp',
    );
    expect(document.querySelector('input[name="sourceMetadataCanonicalUrl"]')).toHaveValue(
      'https://github.com/acme/catalog-mcp',
    );
  });

  it('does not submit package source metadata while editing a connector', () => {
    render(<ServerForm
      action={vi.fn().mockResolvedValue({})}
      initial={{ sourceRef: 'https://mcp.example.com/mcp', sourceUrl: 'https://github.com/acme/mcp' }}
      categories={[]}
      submitLabel="Save"
      showSourceMetadata={false}
    />);

    expect(screen.queryByRole('button', { name: 'Fetch metadata' })).not.toBeInTheDocument();
    expect(document.querySelector('input[name="sourceMetadataCanonicalUrl"]')).not.toBeInTheDocument();
  });

});
