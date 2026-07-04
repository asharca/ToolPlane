import type { Metadata } from 'next';
import { ContentPage } from '@/components/theme/ContentPage';

export const metadata: Metadata = {
  title: 'What is an MCP Server? | ToolPlane',
};

export default function Page() {
  return (
    <ContentPage title="What is an MCP server?">
      <p>
        An MCP (Model Context Protocol) server is a small program that exposes
        tools, data, and prompts to AI applications through a single standard
        interface. Instead of building a custom integration for every service,
        an AI app can connect to any MCP server and immediately use what it
        offers.
      </p>
      <p>
        A client inside the AI app connects to the server over a transport such
        as stdio or streamable HTTP. The server advertises its capabilities —
        for example querying a database, calling an API, or reading files — and
        the model can discover and invoke them at runtime.
      </p>
      <p>
        Because the protocol is standardized, the same server works across any
        MCP-compatible client, and developers can extend what their AI can do
        simply by adding more servers.
      </p>
    </ContentPage>
  );
}
