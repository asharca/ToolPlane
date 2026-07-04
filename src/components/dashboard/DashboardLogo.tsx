export function DashboardLogo() {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="flex items-baseline text-xl tracking-tight">
        <span className="font-semibold text-foreground">Tool</span>
        <span className="font-medium italic text-muted-foreground">Plane</span>
      </span>
      <span className="text-sm text-zinc-300">│</span>
      <span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-foreground">
        HUB
      </span>
    </span>
  );
}
