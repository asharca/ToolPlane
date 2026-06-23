const FAQS: { q: string; a: string }[] = [
  {
    q: 'What is MCP (Model Context Protocol)?',
    a: 'MCP is an open protocol that standardizes how AI applications connect to external tools and data sources, letting models discover and call tools through a single consistent interface.',
  },
  {
    q: 'How does MCP work?',
    a: 'An MCP client inside an AI app connects to MCP servers over a transport such as stdio or streamable HTTP. Servers expose tools, resources, and prompts that the model can discover and invoke at runtime.',
  },
  {
    q: 'What can MCP servers do?',
    a: 'Servers expose capabilities like querying databases, calling APIs, reading files, browsing the web, or running domain-specific actions — turning external systems into tools an AI agent can use.',
  },
  {
    q: 'Who uses MCP?',
    a: 'Developers building AI agents and assistants, plus clients like Claude, Cursor, and other MCP-compatible tools that let users plug in servers to extend what their AI can do.',
  },
  {
    q: 'How do I install an MCP server?',
    a: 'Add the server to your client’s MCP configuration with its command or URL and any required credentials. The client then launches or connects to it and exposes its tools to the model.',
  },
  {
    q: 'Is MCP secure?',
    a: 'Security depends on which servers you trust and the permissions you grant. Run only servers you trust, scope credentials narrowly, and review the tools a server exposes before connecting.',
  },
  {
    q: 'What’s the difference between MCP and regular APIs?',
    a: 'A regular API is a bespoke integration per service. MCP is a standard layer on top, so any compliant client can discover and use any compliant server without custom glue code.',
  },
  {
    q: 'Can I build my own MCP server?',
    a: 'Yes. Using the official SDKs you can wrap any data source or tool as an MCP server, define its tools and resources, and connect it to any MCP-compatible client.',
  },
];

export function FaqSection() {
  return (
    <section className="py-12">
      <h2 className="mb-6 text-xl font-semibold tracking-tight text-foreground">
        Frequently Asked Questions
      </h2>
      <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
        {FAQS.map((f) => (
          <details key={f.q} className="group px-5 py-4">
            <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-medium text-foreground">
              {f.q}
              <span className="ml-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-45">
                +
              </span>
            </summary>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              {f.a}
            </p>
          </details>
        ))}
      </div>
    </section>
  );
}
