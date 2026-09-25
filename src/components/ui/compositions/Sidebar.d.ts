import { type ButtonHTMLAttributes, type HTMLAttributes } from 'react';
export type SidebarActionRailProps = HTMLAttributes<HTMLDivElement> & {
    active?: boolean;
    hasLeadingSlot?: boolean;
    revealOnCellFocus?: boolean;
};
export declare function SidebarActionRail({ active, children, className, hasLeadingSlot, revealOnCellFocus, ...props }: SidebarActionRailProps): import("react").JSX.Element;
export type SidebarActionButtonProps = ButtonHTMLAttributes<HTMLButtonElement>;
export declare const SidebarActionButton: import("react").ForwardRefExoticComponent<SidebarActionButtonProps & import("react").RefAttributes<HTMLButtonElement>>;
