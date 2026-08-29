import Link from 'next/link';
import { ArrowRight, Braces, ChevronRight, Wrench } from 'lucide-react';
import type { McpToolDefinition } from '@/lib/process/mcp-tool-catalog';

type Labels = {
  title: string;
  description: string;
  descriptionColumn?: string;
  count: string;
  instructions: string;
  inputSchema: string;
  schemaJson: string;
  parameter: string;
  type: string;
  required: string;
  defaultValue: string;
  noDescription: string;
  noArguments: string;
};

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function schemaType(schema: Record<string, unknown>): string {
  if (typeof schema.type === 'string') return schema.type;
  if (Array.isArray(schema.type)) {
    const types = schema.type.filter((value): value is string => typeof value === 'string');
    if (types.length) return types.join(' | ');
  }
  if (Array.isArray(schema.enum)) return 'enum';
  if (Array.isArray(schema.oneOf)) return 'oneOf';
  if (Array.isArray(schema.anyOf)) return 'anyOf';
  return 'any';
}

function formattedValue(value: unknown): string | null {
  if (value === undefined) return null;
  const json = JSON.stringify(value);
  return json === undefined ? String(value) : json;
}

export function McpToolCatalog({
  tools,
  labels,
  hrefForTool,
  compact = false,
}: {
  tools: McpToolDefinition[];
  labels: Labels;
  hrefForTool?: (toolName: string) => string;
  compact?: boolean;
}) {
  if (compact) {
    return (
      <section className="ui-panel overflow-hidden">
        <header className="flex flex-wrap items-start justify-between gap-3 px-5 py-4">
          <div className="flex min-w-0 items-start gap-2.5">
            <Wrench className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div>
              <h2 className="text-sm font-semibold text-foreground">{labels.title}</h2>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">{labels.description}</p>
            </div>
          </div>
          <span className="rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">{labels.count}</span>
        </header>
        <div className="space-y-1 px-3 pb-3 sm:px-5 sm:pb-5">
          {tools.map((tool) => {
            const description = tool.description?.trim();
            const content = (
              <>
                <span className="min-w-0 flex-1">
                  <code className="break-all font-mono text-sm font-semibold text-foreground">{tool.name}</code>
                  {tool.title && tool.title !== tool.name ? (
                    <span className="ml-2 text-xs text-muted-foreground">{tool.title}</span>
                  ) : null}
                  <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                    {description ? `${description.slice(0, 240)}${description.length > 240 ? '…' : ''}` : labels.noDescription}
                  </span>
                </span>
                {hrefForTool ? <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" /> : null}
              </>
            );
            const className = 'flex min-w-0 items-start gap-3 rounded-md px-3 py-3 hover:bg-muted/35';
            return hrefForTool ? (
              <Link key={tool.name} href={hrefForTool(tool.name)} aria-label={tool.name} className={className}>{content}</Link>
            ) : (
              <div key={tool.name} className={className}>{content}</div>
            );
          })}
        </div>
      </section>
    );
  }

  return (
    <section className="ui-panel overflow-hidden">
      <header className="flex flex-wrap items-start justify-between gap-3 px-5 py-4">
        <div className="flex min-w-0 items-start gap-2.5">
          <Wrench className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div>
            <h2 className="text-sm font-semibold text-foreground">{labels.title}</h2>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{labels.description}</p>
          </div>
        </div>
        <span className="rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">
          {labels.count}
        </span>
      </header>

      <div className="space-y-2 px-3 pb-3 sm:px-5 sm:pb-5">
        {tools.map((tool, index) => {
          const schema = object(tool.inputSchema) ?? { type: 'object', properties: {} };
          const properties = object(schema.properties) ?? {};
          const required = new Set(
            Array.isArray(schema.required)
              ? schema.required.filter((value): value is string => typeof value === 'string')
              : [],
          );

          return (
            <details
              key={tool.name}
              open={index === 0}
              className="group relative rounded-lg bg-muted/25 open:bg-muted/35"
            >
              <summary className={`flex cursor-pointer list-none items-start gap-3 px-3 py-3 marker:content-none sm:px-4 ${hrefForTool ? 'pr-12 sm:pr-12' : ''}`}>
                <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
                <span className="min-w-0 flex-1">
                  <code className="break-all font-mono text-sm font-semibold text-foreground">{tool.name}</code>
                  {'title' in tool && typeof tool.title === 'string' && tool.title !== tool.name ? (
                    <span className="ml-2 text-xs text-muted-foreground">{tool.title}</span>
                  ) : null}
                </span>
              </summary>
              {hrefForTool ? (
                <Link
                  href={hrefForTool(tool.name)}
                  aria-label={tool.name}
                  className="absolute right-3 top-2.5 rounded-md p-1 text-muted-foreground hover:bg-background hover:text-foreground"
                >
                  <ArrowRight className="size-3.5" />
                </Link>
              ) : null}

              <div className="space-y-5 px-4 pb-4 pl-10">
                <section>
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {labels.instructions}
                  </h3>
                  <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-foreground">
                    {tool.description?.trim() || labels.noDescription}
                  </p>
                </section>

                <section>
                  <div className="flex items-center gap-2">
                    <Braces className="size-4 text-muted-foreground" />
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {labels.inputSchema}
                    </h3>
                  </div>

                  {Object.keys(properties).length ? (
                    <div className="mt-3 overflow-x-auto rounded-md bg-background/70">
                      <table className="w-full min-w-[36rem] text-left text-xs">
                        <thead className="text-muted-foreground">
                          <tr>
                            <th className="px-3 py-2 font-medium">{labels.parameter}</th>
                            <th className="px-3 py-2 font-medium">{labels.type}</th>
                            <th className="px-3 py-2 font-medium">{labels.required}</th>
                            <th className="px-3 py-2 font-medium">{labels.descriptionColumn ?? labels.description}</th>
                            <th className="px-3 py-2 font-medium">{labels.defaultValue}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {Object.entries(properties).map(([name, value]) => {
                            const property = object(value) ?? {};
                            return (
                              <tr key={name} className="align-top">
                                <td className="px-3 py-2.5"><code className="font-mono text-foreground">{name}</code></td>
                                <td className="px-3 py-2.5 font-mono text-muted-foreground">{schemaType(property)}</td>
                                <td className="px-3 py-2.5 text-muted-foreground">{required.has(name) ? labels.required : '—'}</td>
                                <td className="max-w-md px-3 py-2.5 leading-5 text-muted-foreground">
                                  {typeof property.description === 'string' ? property.description : '—'}
                                </td>
                                <td className="px-3 py-2.5 font-mono text-muted-foreground">
                                  {formattedValue(property.default) ?? '—'}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="mt-2 text-sm text-muted-foreground">{labels.noArguments}</p>
                  )}

                  <details open className="group/schema mt-3">
                    <summary className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground">
                      {labels.schemaJson}
                    </summary>
                    <pre className="mt-2 max-h-96 overflow-auto rounded-md bg-background/70 p-3 font-mono text-xs leading-5 text-foreground">
                      {JSON.stringify(schema, null, 2)}
                    </pre>
                  </details>
                </section>
              </div>
            </details>
          );
        })}
      </div>
    </section>
  );
}
