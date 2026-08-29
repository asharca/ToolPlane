import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { McpToolCatalog } from '@/components/dashboard/McpToolCatalog';

const labels = {
  title: 'Tool catalog',
  description: 'Inspect every tool.',
  count: '2 tools',
  instructions: 'Instructions',
  inputSchema: 'Input schema',
  schemaJson: 'JSON schema',
  parameter: 'Parameter',
  type: 'Type',
  required: 'Required',
  defaultValue: 'Default',
  noDescription: 'No description.',
  noArguments: 'No arguments.',
};

describe('McpToolCatalog', () => {
  it('shows instructions, parameter details, and the complete input schema', () => {
    const { container } = render(<McpToolCatalog
      labels={labels}
      hrefForTool={(name) => `/tools/${name}`}
      tools={[{
        name: 'search_products',
        title: 'Search products',
        description: 'Search the product catalog by keyword.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search term' },
            page: { type: 'integer', description: '1-based page', default: 1 },
          },
          required: ['query'],
        },
      }, {
        name: 'list_categories',
        description: 'List all categories.',
        inputSchema: { type: 'object', properties: {} },
      }]}
    />);

    expect(screen.getByText('Search the product catalog by keyword.')).toBeInTheDocument();
    expect(screen.getByText('query')).toBeInTheDocument();
    expect(screen.getByText('Search term')).toBeInTheDocument();
    expect(screen.getByText('1-based page')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(container.querySelector('details[open] summary')).toHaveTextContent('search_products');
    expect(screen.getByText(/"required": \[/)).toBeInTheDocument();
    expect(screen.getByText('No arguments.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'search_products' })).toHaveAttribute(
      'href',
      '/tools/search_products',
    );
    expect(screen.getByRole('link', { name: 'search_products' }).closest('summary')).toBeNull();
  });

  it('renders a lightweight linked catalog without eagerly rendering schemas', () => {
    const { container } = render(<McpToolCatalog
      compact
      labels={labels}
      hrefForTool={(name) => `/tools/${name}`}
      tools={[{
        name: 'search_products',
        description: 'Search the product catalog by keyword.',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string', description: 'Search term' } },
        },
      }]}
    />);

    expect(screen.getByRole('link', { name: /search_products/ })).toHaveAttribute('href', '/tools/search_products');
    expect(container.querySelector('table')).not.toBeInTheDocument();
    expect(screen.queryByText('Search term')).not.toBeInTheDocument();
  });
});
