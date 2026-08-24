import { Layers3 } from 'lucide-react';

type LogoProps = {
  svgSize?: number;
  wordmarkClass?: string;
  hideWordmarkOnMobile?: boolean;
};

export function Logo({
  svgSize = 28,
  wordmarkClass = 'text-2xl',
  hideWordmarkOnMobile = false,
}: LogoProps) {
  return (
    <span className="inline-flex items-center gap-2">
      <span
        aria-hidden="true"
        className="inline-flex shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand ring-1 ring-inset ring-brand/15 transition-colors group-hover:bg-brand group-hover:text-brand-foreground"
        style={{ width: svgSize, height: svgSize }}
      >
        <Layers3 size={Math.round(svgSize * 0.57)} strokeWidth={1.9} />
      </span>
      <span
        className={`${hideWordmarkOnMobile ? 'hidden sm:inline' : 'inline'} whitespace-nowrap font-sans font-semibold tracking-[-0.035em] text-foreground ${wordmarkClass}`}
      >
        Tool<span className="font-medium text-muted-foreground">Plane</span>
      </span>
    </span>
  );
}
