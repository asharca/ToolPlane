import type { ButtonHTMLAttributes, ComponentPropsWithoutRef, ReactNode } from 'react';
export type ChipProps = ComponentPropsWithoutRef<'span'> & {
    active?: boolean;
    asChild?: boolean;
};
export declare function Chip({ active, asChild, className, ...props }: ChipProps): import("react").JSX.Element;
export type TabListProps = ComponentPropsWithoutRef<'div'> & {
    label: string;
    navigation?: boolean;
};
export declare function TabList({ className, label, navigation, ...props }: TabListProps): import("react").JSX.Element;
export type NavigationTabsProps = ComponentPropsWithoutRef<'nav'> & {
    contentClassName?: string;
};
export declare function NavigationTabs({ children, className, contentClassName, ...props }: NavigationTabsProps): import("react").JSX.Element;
export type BreadcrumbsProps = ComponentPropsWithoutRef<'nav'>;
export declare function Breadcrumbs({ 'aria-label': ariaLabel, children, className, ...props }: BreadcrumbsProps): import("react").JSX.Element;
export type BreadcrumbItemProps = ComponentPropsWithoutRef<'li'> & {
    current?: boolean;
    separator?: ReactNode;
};
export declare function BreadcrumbItem({ children, className, current, separator, ...props }: BreadcrumbItemProps): import("react").JSX.Element;
export type TabProps = ButtonHTMLAttributes<HTMLButtonElement> & {
    asChild?: boolean;
    count?: number;
    current?: boolean;
    navigation?: boolean;
};
export declare function Tab({ asChild, children, className, count, current, navigation, type, ...props }: TabProps): import("react").JSX.Element;
export type TabPanelProps = ComponentPropsWithoutRef<'div'> & {
    current?: boolean;
};
export declare function TabPanel({ className, current, ...props }: TabPanelProps): import("react").JSX.Element;
export type PaginationProps = Omit<ComponentPropsWithoutRef<'nav'>, 'children'> & {
    next?: ReactNode;
    previous?: ReactNode;
    summary: ReactNode;
};
export declare function Pagination({ className, next, previous, summary, ...props }: PaginationProps): import("react").JSX.Element;
