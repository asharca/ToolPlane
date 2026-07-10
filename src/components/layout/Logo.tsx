type LogoProps = {
  svgSize?: number;
  wordmarkClass?: string;
  hideWordmarkOnMobile?: boolean;
};

export function Logo({
  wordmarkClass = 'text-2xl',
  hideWordmarkOnMobile = false,
}: LogoProps) {
  return (
    <span
      className={`${hideWordmarkOnMobile ? 'hidden sm:inline-flex' : 'inline-flex'} items-baseline ${wordmarkClass}`}
    >
      <span className="font-sans font-semibold text-foreground">Tool</span>
      <span className="font-sans font-medium text-foreground/65">Plane</span>
    </span>
  );
}
