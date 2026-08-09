import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ pending: false }));

vi.mock('react-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-dom')>();
  return {
    ...actual,
    useFormStatus: () => ({
      pending: mocks.pending,
      data: null,
      method: null,
      action: null,
    }),
  };
});

import { SubmitButton } from '@/components/dashboard/SubmitButton';

describe('toolkit market import submit button', () => {
  it('disables itself and announces progress while the import action is pending', () => {
    mocks.pending = true;

    render(
      <SubmitButton pendingLabel="Importing…" flash={false}>
        Import
      </SubmitButton>,
    );

    expect(screen.getByRole('button', { name: 'Importing…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Importing…' })).toHaveAttribute(
      'aria-busy',
      'true',
    );
  });

  it('is enabled before an import starts', () => {
    mocks.pending = false;

    render(
      <SubmitButton pendingLabel="Importing…" flash={false}>
        Import
      </SubmitButton>,
    );

    expect(screen.getByRole('button', { name: 'Import' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Import' })).toHaveAttribute(
      'aria-busy',
      'false',
    );
  });
});
