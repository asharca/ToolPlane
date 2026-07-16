import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SafeStreamdown } from '@/components/dashboard/SafeStreamdown';

describe('SafeStreamdown', () => {
  it('renders assistant soft line endings as visible breaks', () => {
    const view = render(
      <SafeStreamdown mode="static" preserveSoftBreaks>
        {'Current tools:\nRouterOS MCP\nSSH MCP'}
      </SafeStreamdown>,
    );

    expect(view.container.querySelectorAll('br')).toHaveLength(2);
  });

  it('keeps Streamdown default GFM support when preserving soft breaks', () => {
    const view = render(
      <SafeStreamdown mode="static" preserveSoftBreaks>
        {'First line\n~~removed~~'}
      </SafeStreamdown>,
    );

    expect(view.container.querySelector('br')).not.toBeNull();
    expect(view.container.querySelector('del')).toHaveTextContent('removed');
  });

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
