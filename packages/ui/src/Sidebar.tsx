import {
  forwardRef,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
} from 'react';

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(' ');
}

export type SidebarActionRailProps = HTMLAttributes<HTMLDivElement> & {
  active?: boolean;
  hasLeadingSlot?: boolean;
  revealOnCellFocus?: boolean;
};

export function SidebarActionRail({
  active = false,
  children,
  className,
  hasLeadingSlot = false,
  revealOnCellFocus = false,
  ...props
}: SidebarActionRailProps) {
  return (
    <div
      {...props}
      data-active={active || undefined}
      data-toolplane-ui="sidebar-action-rail"
      className={cx(
        '-ml-1.5 pointer-events-none grid shrink-0 grid-cols-[0fr] opacity-0 transition-[grid-template-columns,opacity] duration-150 motion-reduce:transition-none',
        hasLeadingSlot ? 'mr-0' : '-mr-1',
        'focus-within:pointer-events-auto focus-within:grid-cols-[1fr] focus-within:opacity-100 group-hover:pointer-events-auto group-hover:grid-cols-[1fr] group-hover:opacity-100',
        'has-data-[state=open]:pointer-events-auto has-data-[state=open]:grid-cols-[1fr] has-data-[state=open]:opacity-100 group-data-[state=open]:pointer-events-auto group-data-[state=open]:grid-cols-[1fr] group-data-[state=open]:opacity-100',
        'data-[active=true]:pointer-events-auto data-[active=true]:grid-cols-[1fr] data-[active=true]:opacity-100',
        revealOnCellFocus && 'group-has-[:focus-visible]:pointer-events-auto group-has-[:focus-visible]:grid-cols-[1fr] group-has-[:focus-visible]:opacity-100',
        className,
      )}
    >
      <div className="flex min-w-0 items-center overflow-hidden">{children}</div>
    </div>
  );
}

export type SidebarActionButtonProps = ButtonHTMLAttributes<HTMLButtonElement>;

export const SidebarActionButton = forwardRef<HTMLButtonElement, SidebarActionButtonProps>(
  function SidebarActionButton({ className, type = 'button', ...props }, ref) {
    return (
      <button
        {...props}
        ref={ref}
        type={type}
        data-toolplane-ui="sidebar-action-button"
        className={cx(
          'pointer-events-none flex size-5 shrink-0 items-center justify-center rounded-lg text-muted-foreground opacity-0 outline-none transition-all duration-150',
          'hover:bg-accent hover:text-foreground focus-visible:pointer-events-auto focus-visible:bg-accent focus-visible:text-foreground focus-visible:opacity-100',
          'group-hover:pointer-events-auto group-hover:opacity-100 group-data-[state=open]:pointer-events-auto group-data-[state=open]:opacity-100 data-[active=true]:pointer-events-auto data-[active=true]:opacity-100 data-[deleting=true]:pointer-events-auto data-[deleting=true]:opacity-100',
          className,
        )}
      />
    );
  },
);
