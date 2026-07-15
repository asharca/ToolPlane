import type { ComponentPropsWithoutRef } from 'react';
import { ChevronDown } from 'lucide-react';

type NativeSelectProps = ComponentPropsWithoutRef<'select'> & {
  wrapperClassName?: string;
};

export function NativeSelect({
  children,
  className,
  disabled,
  wrapperClassName,
  ...props
}: NativeSelectProps) {
  return (
    <span className={`ui-select ${wrapperClassName ?? ''}`.trim()}>
      <select
        {...props}
        disabled={disabled}
        className={`ui-select-control ${className ?? ''}`.trim()}
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden="true"
        className={`ui-select-chevron ${disabled ? 'opacity-40' : ''}`.trim()}
      />
    </span>
  );
}
