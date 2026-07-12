const STYLES: Record<string, { dot: string; label: string }> = {
  running: { dot: 'bg-emerald-500', label: 'Running' },
  error: { dot: 'bg-red-500', label: 'Error' },
  provisioning: { dot: 'bg-amber-500', label: 'Provisioning' },
  setup_required: { dot: 'bg-amber-500', label: 'Setup required' },
  stopped: { dot: 'bg-zinc-400', label: 'Stopped' },
};

export function StatusBadge({ status }: { status: string }) {
  const s = STYLES[status] ?? STYLES.provisioning;
  return (
    <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
      <span className={`size-2 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  );
}
