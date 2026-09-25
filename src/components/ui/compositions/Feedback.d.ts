import type { ComponentPropsWithoutRef, ReactNode } from 'react';
export type FeedbackTone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger';
export type BadgeProps = ComponentPropsWithoutRef<'span'> & {
    tone?: FeedbackTone;
};
export declare function Badge({ className, tone, ...props }: BadgeProps): import("react").JSX.Element;
export type StatusBadgeProps = Omit<BadgeProps, 'children'> & {
    appearance?: 'badge' | 'plain';
    dot?: boolean;
    dotClassName?: string;
    label: ReactNode;
};
export declare function StatusBadge({ appearance, className, dot, dotClassName, label, tone, ...props }: StatusBadgeProps): import("react").JSX.Element;
export type AlertTone = 'info' | 'success' | 'warning' | 'danger';
export type AlertProps = ComponentPropsWithoutRef<'div'> & {
    tone?: AlertTone;
};
export declare function Alert({ className, role, tone, ...props }: AlertProps): import("react").JSX.Element;
export type SpinnerProps = ComponentPropsWithoutRef<'span'> & {
    label?: string;
};
export declare function Spinner({ className, label, ...props }: SpinnerProps): import("react").JSX.Element;
