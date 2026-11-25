export function DashboardHeader({
  title,
  visible = false,
}: {
  title: string;
  visible?: boolean;
}) {
  return (
    <h1
      className={
        visible
          ? "sr-only md:not-sr-only md:block md:text-lg md:font-semibold md:tracking-tight md:text-foreground"
          : "sr-only"
      }
    >
      {title}
    </h1>
  );
}
