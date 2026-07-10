import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SafeStreamdown } from '@/components/dashboard/SafeStreamdown';

describe('SafeStreamdown', () => {
  it('does not render script tags even if custom allowed tags include them', () => {
    const view = render(
      <SafeStreamdown mode="static" allowedTags={{ script: [] }}>
        {'Plain **markdown** <script>alert("x")</script>'}
      </SafeStreamdown>,
    );

    expect(screen.getByText('markdown')).toBeInTheDocument();
    expect(view.container.querySelector('script')).toBeNull();
  });
});
