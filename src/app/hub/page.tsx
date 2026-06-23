import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'MCP Market Hub | Power Your Agents',
};

export default function Page() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-20 text-center">
      <h1 className="text-4xl font-bold tracking-tight text-foreground sm:text-5xl">
        MCP Market Hub
      </h1>
      <p className="mx-auto mt-4 max-w-xl text-base text-muted-foreground">
        Power your agents — connect to hundreds of MCP servers through a single
        gateway.
      </p>
      <div className="mt-8 flex justify-center gap-3">
        <Link
          href="/server"
          className="inline-flex h-10 items-center rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          Browse Servers
        </Link>
        <Link
          href="/search"
          className="inline-flex h-10 items-center rounded-md border border-border px-5 text-sm font-medium text-foreground transition-colors hover:bg-accent"
        >
          Search
        </Link>
      </div>
    </div>
  );
}
