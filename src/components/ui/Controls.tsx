'use client';

import {
  Children, cloneElement, forwardRef, isValidElement, useImperativeHandle, useRef,
  type ButtonHTMLAttributes, type ComponentPropsWithoutRef, type InputHTMLAttributes,
  type ReactElement, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes,
} from 'react';
import { ChevronDown, Loader2, Search, X } from 'lucide-react';
import { Slot } from 'radix-ui';
import { Button as RegistryButton, type ButtonProps as RegistryButtonProps } from './beui/components/motion/button/base';
import { Input as RegistryInput } from './beui/components/motion/input';
import { cn } from './beui/lib/utils';

export type ControlSize = 'sm' | 'md' | 'lg';
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-secondary';
export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  asChild?: boolean; loading?: boolean; loadingLabel?: string; size?: ControlSize;
  variant?: ButtonVariant;
  /** Structural controls (drag handles, navigation rows) retain their layout. */
  unstyled?: boolean;
  /** Preserve the browser submit default when migrating an intrinsic button. */
  nativeButton?: boolean;
};
const sizes = { sm: 'ui-button-sm', md: '', lg: 'ui-button-lg' };
const variants = {
  primary: 'ui-button-primary', secondary: 'ui-button-secondary', ghost: 'ui-button-ghost',
  danger: 'ui-button-primary ui-button-danger', 'danger-secondary': 'ui-button-secondary ui-button-danger-secondary',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({
  asChild = false, children, className, disabled, loading = false, loadingLabel,
  size = 'md', variant = 'secondary', unstyled = false, nativeButton = false, type = nativeButton ? 'submit' : 'button', onClick,
  'aria-busy': ariaBusy, ...props
}, ref) {
  const busy = Boolean(disabled || loading);
  const classes = cn(unstyled ? 'beui-structural-button' : variants[variant], !unstyled && sizes[size], className);
  const common = {
    'data-toolplane-ui': 'button', 'data-ui-engine': 'beui', ...props, ref, className: classes,
    'aria-busy': loading ? true : ariaBusy,
  };
  if (asChild) {
    // Radix composes the child's handler before the slot handler. Gate the child
    // itself so a disabled link cannot execute its action before prevention.
    const child = Children.only(children);
    const safeChild = busy && isValidElement(child)
      ? cloneElement(child as ReactElement<{ onClick?: (event: React.MouseEvent) => void }>, {
          onClick: (event: React.MouseEvent) => { event.preventDefault(); event.stopPropagation(); },
        })
      : child;
    return <Slot.Root {...common} aria-disabled={busy || undefined} tabIndex={busy ? -1 : props.tabIndex}
      onClick={(event: React.MouseEvent<HTMLButtonElement>) => {
        if (busy) { event.preventDefault(); event.stopPropagation(); return; }
        onClick?.(event);
      }}>{safeChild}</Slot.Root>;
  }
  const content = <>{loading ? <Loader2 aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" /> : null}{loading && loadingLabel ? loadingLabel : children}</>;
  // Motion's onDrag/onAnimationStart are gesture callbacks, not HTML events.
  // Preserve native drag-and-drop and animation events on tab/row controls.
  const nativeEvents = props.draggable || props.onDrag || props.onDragStart || props.onDragEnd || props.onAnimationStart;
  if (nativeEvents) return <button {...common} type={type} disabled={busy} onClick={onClick}>{content}</button>;
  return <RegistryButton {...common as Omit<RegistryButtonProps, 'children'>}
    type={type} disabled={busy} onClick={onClick} pressScale={unstyled ? 1 : 0.98}
    whileHover={undefined} size={size} variant={variant === 'primary' || variant === 'danger' ? 'primary' : variant === 'ghost' ? 'ghost' : 'secondary'}
    className={cn(unstyled && 'h-auto w-auto rounded-none border-0 bg-transparent p-0 font-[inherit] text-inherit shadow-none hover:bg-transparent', classes)}>
    {content}
  </RegistryButton>;
});

export type IconButtonProps = Omit<ButtonProps, 'children' | 'loadingLabel'> & { icon: ReactNode; label: string };
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton({ icon, label, title, className, size = 'md', loading, ...props }, ref) {
  return <Button {...props} ref={ref} size={size} loading={loading} aria-label={label} title={title ?? label}
    className={cn('ui-icon-button', `ui-icon-button-${size}`, className)}>
    {loading ? null : <span aria-hidden="true" className="inline-flex">{icon}</span>}
  </Button>;
});

export type InputProps = InputHTMLAttributes<HTMLInputElement> & { controlSize?: ControlSize };
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ type = 'text', className, controlSize = 'md', value, defaultValue, onChange, ...props }, ref) {
  const classes = cn('ui-input', controlSize === 'sm' && 'ui-input-sm', controlSize === 'lg' && 'ui-input-lg', className);
  if (type === 'checkbox') return <Checkbox {...props} ref={ref} className={className} value={value} defaultValue={defaultValue} onChange={onChange} />;
  if (type === 'radio') return <Radio {...props} ref={ref} className={className} value={value} defaultValue={defaultValue} onChange={onChange} />;
  // Files must never become controlled; hidden values are not visual widgets.
  if (type === 'file' || type === 'hidden' || type === 'range' || type === 'color') {
    return <input {...props} ref={ref} type={type} value={type === 'file' ? undefined : value} defaultValue={type === 'file' ? undefined : defaultValue}
      onChange={onChange} className={type === 'hidden' ? className : cn('beui-native-input', className)} data-ui-engine="beui" />;
  }
  return <RegistryInput {...props} ref={ref} type={type} nativeLayout
    value={value === undefined ? undefined : String(value)} defaultValue={defaultValue === undefined ? undefined : String(defaultValue)}
    onNativeChange={onChange} data-toolplane-ui="input" data-ui-engine="beui"
    classNames={{ input: cn('h-10 rounded-xl border border-input bg-background px-3.5 text-sm focus-visible:ring-2 focus-visible:ring-ring/30', classes) }} />;
});

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea({ className, ...props }, ref) {
  return <textarea {...props} ref={ref} data-toolplane-ui="textarea" data-ui-engine="beui" className={cn('ui-textarea rounded-xl focus-visible:ring-2 focus-visible:ring-ring/30', className)} />;
});

export type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & { controlSize?: ControlSize; wrapperClassName?: string };
export type NativeSelectProps = SelectProps;
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select({ children, className, wrapperClassName, controlSize = 'md', disabled, multiple, size, ...props }, ref) {
  // Native semantics retain FormData, required validation, optgroups, reset,
  // typeahead, multiple selection, autofocus and existing ref consumers.
  const list = multiple || (size !== undefined && size > 1);
  return <span data-toolplane-ui="select" data-ui-engine="beui" className={cn('ui-select', wrapperClassName)}>
    <select {...props} ref={ref} disabled={disabled} multiple={multiple} size={size}
      className={cn('ui-input rounded-xl', !list && 'ui-select-control', list && 'h-auto', controlSize === 'sm' && 'ui-input-sm', controlSize === 'lg' && 'ui-input-lg', className)}>{children}</select>
    {!list ? <ChevronDown aria-hidden="true" className={cn('ui-select-chevron', disabled && 'opacity-40')} /> : null}
  </span>;
});
export const NativeSelect = Select;
export type CheckboxProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>;
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox({ className, ...props }, ref) {
  // beUI checkmark geometry, with a real input rather than role=checkbox button:
  // callers retain checked/defaultChecked, label activation and form behavior.
  if (props.role === 'switch' || /(?:^|\s)(?:peer|sr-only)(?:\s|$)/.test(className ?? '')) {
    return <input {...props} ref={ref} type="checkbox" data-ui-engine="beui" className={className} />;
  }
  return <span className="beui-choice">
    <input {...props} ref={ref} type="checkbox" data-toolplane-ui="checkbox" data-ui-engine="beui" className={cn('ui-checkbox beui-checkbox', className)} />
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" className="beui-choice-mark"><path d="M5 13l4 4L19 7" /><path d="M6 12h12" /></svg>
  </span>;
});
export type RadioProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>;
export const Radio = forwardRef<HTMLInputElement, RadioProps>(function Radio({ className, ...props }, ref) {
  return <input {...props} ref={ref} type="radio" data-toolplane-ui="radio" data-ui-engine="beui" className={cn('ui-radio beui-radio', className)} />;
});
export function Field({ className, ...props }: ComponentPropsWithoutRef<'div'>) { return <div {...props} data-toolplane-ui="field" className={cn('ui-field', className)} />; }
export function FieldLabel({ className, ...props }: ComponentPropsWithoutRef<'label'>) { return <label {...props} className={cn('ui-field-label', className)} />; }
export function FieldDescription({ className, ...props }: ComponentPropsWithoutRef<'p'>) { return <p {...props} className={cn('ui-field-description', className)} />; }
export function FieldError({ className, role = 'alert', ...props }: ComponentPropsWithoutRef<'p'>) { return <p {...props} role={role} className={cn('ui-field-error', className)} />; }
export type SearchInputProps = Omit<InputProps, 'defaultValue' | 'type' | 'value'> & { clearLabel?: string; label: string; onClear: () => void; value: string; wrapperClassName?: string };
export const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(function SearchInput({ clearLabel = 'Clear search', className, label, onClear, value, wrapperClassName, ...props }, ref) {
  const inputRef = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => inputRef.current!);
  return <div data-toolplane-ui="search-input" className={cn('tp-search-input', wrapperClassName)}>
    <Search aria-hidden="true" className="tp-search-input__icon" />
    <Input {...props} ref={inputRef} type="search" value={value} aria-label={label} className={cn('tp-search-input__control', className)} />
    {value ? <IconButton icon={<X className="size-3.5" />} label={clearLabel} size="sm" variant="ghost" className="tp-search-input__clear"
      onClick={() => { onClear(); inputRef.current?.focus(); }} /> : null}
  </div>;
});

export const Table = forwardRef<HTMLTableElement, ComponentPropsWithoutRef<'table'>>(function Table({ className, ...props }, ref) {
  return <table {...props} ref={ref} data-ui-engine="beui" className={cn('beui-table', className)} />;
});
