import { cn } from '@/lib/utils';

export interface LogoProps {
  svgSize?: number;
  wordmarkClass?: string;
}

export function Logo({ svgSize = 32, wordmarkClass }: LogoProps) {
  return (
    <span className="inline-flex items-center gap-2 text-foreground">
      <svg width={svgSize} height={svgSize} viewBox="0 0 64 64" fill="currentColor" aria-hidden="true">
        <path d="M12 14h30v9H31v27H21V23h-9z" />
        <path d="m34 27 20 9-20 9 4-7H29v-4h9z" />
      </svg>
      <span className={cn('text-xl font-semibold tracking-tight', wordmarkClass)}>ToolPlane</span>
    </span>
  );
}
