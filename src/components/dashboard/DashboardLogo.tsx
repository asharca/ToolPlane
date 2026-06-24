export function DashboardLogo() {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="flex items-baseline text-xl tracking-tight">
        <span className="font-semibold text-zinc-900">MCP</span>
        <span className="font-medium italic text-zinc-500">Market</span>
      </span>
      <span className="text-sm text-zinc-300">│</span>
      <span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-zinc-900">
        HUB
      </span>
    </span>
  );
}
