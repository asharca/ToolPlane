import { ButtonLink } from "@/components/motion/button";

import { AnimatedBadge } from "@/components/motion/animated-badge";
import { BouncyAccordion } from "@/components/motion/bouncy-accordion";
import Link from "next/link";
import { ArrowRight, Braces, Wrench } from "lucide-react";
import type { McpToolDefinition } from "@/lib/process/mcp-tool-catalog";
import { DashboardTable } from "@/components/dashboard/DashboardTable";

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
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function schemaType(schema: Record<string, unknown>): string {
  if (typeof schema.type === "string") return schema.type;
  if (Array.isArray(schema.type)) {
    const types = schema.type.filter(
      (value): value is string => typeof value === "string",
    );
    if (types.length) return types.join(" | ");
  }
  if (Array.isArray(schema.enum)) return "enum";
  if (Array.isArray(schema.oneOf)) return "oneOf";
  if (Array.isArray(schema.anyOf)) return "anyOf";
  return "any";
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
      <section className="min-w-0 max-w-full overflow-hidden">
        <header className="flex flex-wrap items-start justify-between gap-3 px-5 py-4">
          <div className="flex min-w-0 items-start gap-2.5">
            <Wrench className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div>
              <h2 className="text-sm font-semibold text-foreground">
                {labels.title}
              </h2>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {labels.description}
              </p>
            </div>
          </div>
          <AnimatedBadge status="neutral" size="sm" showIcon={false}>
            {labels.count}
          </AnimatedBadge>
        </header>
        <div className="divide-y divide-border px-3 pb-3 sm:px-5 sm:pb-5">
          {tools.map((tool) => {
            const description = tool.description?.trim();
            const content = (
              <>
                <span className="min-w-0 flex-1">
                  <code className="break-all font-mono text-sm font-semibold text-foreground">
                    {tool.name}
                  </code>
                  {tool.title && tool.title !== tool.name ? (
                    <span className="ml-2 text-xs text-muted-foreground">
                      {tool.title}
                    </span>
                  ) : null}
                  <span className="mt-1 block [overflow-wrap:anywhere] text-xs leading-5 text-muted-foreground">
                    {description
                      ? `${description.slice(0, 240)}${description.length > 240 ? "…" : ""}`
                      : labels.noDescription}
                  </span>
                </span>
                {hrefForTool ? (
                  <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" />
                ) : null}
              </>
            );
            const className =
              "flex min-w-0 items-start gap-3 rounded-md px-3 py-3 hover:bg-muted/35";
            return hrefForTool ? (
              <ButtonLink
                key={tool.name}
                href={hrefForTool(tool.name)}
                aria-label={tool.name}
                variant="secondary"
                size="lg"
                className="w-full justify-start text-left"
              >
                {content}
              </ButtonLink>
            ) : (
              <div key={tool.name} className={className}>
                {content}
              </div>
            );
          })}
        </div>
      </section>
    );
  }

  return (
    <section className="min-w-0 max-w-full overflow-hidden">
      <header className="flex flex-wrap items-start justify-between gap-3 px-5 py-4">
        <div className="flex min-w-0 items-start gap-2.5">
          <Wrench className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div>
            <h2 className="text-sm font-semibold text-foreground">
              {labels.title}
            </h2>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {labels.description}
            </p>
          </div>
        </div>
        <AnimatedBadge status="neutral" size="sm" showIcon={false}>
          {labels.count}
        </AnimatedBadge>
      </header>

      <div className="space-y-2 px-3 pb-3 sm:px-5 sm:pb-5">
        {tools.map((tool, index) => {
          const schema = object(tool.inputSchema) ?? {
            type: "object",
            properties: {},
          };
          const properties = object(schema.properties) ?? {};
          const required = new Set(
            Array.isArray(schema.required)
              ? schema.required.filter(
                  (value): value is string => typeof value === "string",
                )
              : [],
          );

          return (
            <BouncyAccordion
              key={tool.name}
              defaultValue={index === 0 ? "details" : null}
              items={[
                {
                  id: "details",
                  title: (
                    <>
                      <span className="min-w-0 flex-1">
                        <code className="break-all font-mono text-sm font-semibold text-foreground">
                          {tool.name}
                        </code>
                        {"title" in tool &&
                        typeof tool.title === "string" &&
                        tool.title !== tool.name ? (
                          <span className="ml-2 text-xs text-muted-foreground">
                            {tool.title}
                          </span>
                        ) : null}
                      </span>
                    </>
                  ),
                  description: (
                    <>
                      {hrefForTool ? (
                        <Link
                          href={hrefForTool(tool.name)}
                          aria-label={tool.name}
                          className="absolute right-3 top-2.5 rounded-md p-1 text-muted-foreground hover:bg-background hover:text-foreground"
                        >
                          <ArrowRight className="size-3.5" />
                        </Link>
                      ) : null}

                      <div className="min-w-0 space-y-5 px-3 pb-4 sm:px-4 sm:pl-10">
                        <section>
                          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                            {labels.instructions}
                          </h3>
                          <p className="mt-2 whitespace-pre-wrap [overflow-wrap:anywhere] text-sm leading-6 text-foreground">
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
                            <DashboardTable
                              className="mt-3"
                              minWidth="36rem"
                              ariaLabel={labels.inputSchema}
                              headers={[
                                { label: labels.parameter },
                                { label: labels.type },
                                { label: labels.required },
                                {
                                  label:
                                    labels.descriptionColumn ??
                                    labels.description,
                                  width: "40%",
                                },
                                { label: labels.defaultValue },
                              ]}
                              rows={Object.entries(properties).map(
                                ([name, value]) => {
                                  const property = object(value) ?? {};
                                  return {
                                    id: name,
                                    cells: [
                                      <code key="name" className="font-mono">
                                        {name}
                                      </code>,
                                      schemaType(property),
                                      required.has(name)
                                        ? labels.required
                                        : "—",
                                      <span
                                        key="description"
                                        title={
                                          typeof property.description ===
                                          "string"
                                            ? property.description
                                            : undefined
                                        }
                                      >
                                        {typeof property.description ===
                                        "string"
                                          ? property.description
                                          : "—"}
                                      </span>,
                                      <code
                                        key="default"
                                        title={
                                          formattedValue(property.default) ??
                                          undefined
                                        }
                                      >
                                        {formattedValue(property.default) ??
                                          "—"}
                                      </code>,
                                    ],
                                  };
                                },
                              )}
                            />
                          ) : (
                            <p className="mt-2 text-sm text-muted-foreground">
                              {labels.noArguments}
                            </p>
                          )}

                          <BouncyAccordion
                            items={[
                              {
                                id: "schema",
                                title: <>{labels.schemaJson}</>,
                                description: (
                                  <>
                                    <pre
                                      // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users must be able to scroll the schema viewport.
                                      tabIndex={0}
                                      className="mt-2 max-h-[min(24rem,50dvh)] max-w-full overflow-auto overscroll-contain rounded-md bg-background/70 p-3 font-mono text-xs leading-5 text-foreground"
                                    >
                                      {JSON.stringify(schema, null, 2)}
                                    </pre>
                                  </>
                                ),
                              },
                            ]}
                          />
                        </section>
                      </div>
                    </>
                  ),
                },
              ]}
            />
          );
        })}
      </div>
    </section>
  );
}
