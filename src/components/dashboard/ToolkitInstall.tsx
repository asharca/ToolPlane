import { CopyButton } from './CopyButton';

export function ToolkitInstall({
  installUrl,
  serverCount,
  skillCount,
}: {
  installUrl: string;
  serverCount: number;
  skillCount: number;
}) {
  const cmd = `curl -fsSL "${installUrl}?token=YOUR_TOKEN" | bash`;

  return (
    <div className="rounded-lg border border-sky-100 bg-sky-50 p-4 dark:border-sky-500/20 dark:bg-sky-500/10">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-zinc-700 dark:text-zinc-200">
          <span className="font-semibold text-zinc-900 dark:text-zinc-100">Install this toolkit</span> — adds its{' '}
          {serverCount} MCP server{serverCount === 1 ? '' : 's'} and {skillCount} skill{skillCount === 1 ? '' : 's'} to
          Claude Code.
        </p>
        <CopyButton text={cmd} label="Copy" />
      </div>
      <pre className="overflow-x-auto rounded-md border border-zinc-200 bg-white p-3 font-mono text-xs text-zinc-800 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200">
        {cmd}
      </pre>
      <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
        Replace <code className="font-mono">YOUR_TOKEN</code> with an API token from Settings → API Tokens. MCP servers
        must be running to expose their tools.
      </p>
    </div>
  );
}
