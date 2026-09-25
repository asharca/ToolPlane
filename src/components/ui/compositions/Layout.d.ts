import type { ComponentPropsWithoutRef, ComponentType, HTMLAttributes, ReactNode } from 'react';
export type PageProps = ComponentPropsWithoutRef<'main'> & {
    as?: 'div' | 'main';
};
export declare function Page({ as: Component, className, ...props }: PageProps): import("react").JSX.Element;
export type PageHeaderProps = Omit<ComponentPropsWithoutRef<'header'>, 'title'> & {
    actions?: ReactNode;
    back?: ReactNode;
    description?: ReactNode;
    meta?: ReactNode;
    title: ReactNode;
};
export declare function PageHeader({ actions, back, className, description, meta, title, ...props }: PageHeaderProps): import("react").JSX.Element;
export type ToolbarProps = ComponentPropsWithoutRef<'div'> & {
    actions?: ReactNode;
};
export declare function Toolbar({ actions, children, className, ...props }: ToolbarProps): import("react").JSX.Element;
export type SectionProps = Omit<ComponentPropsWithoutRef<'section'>, 'title'> & {
    actions?: ReactNode;
    count?: number;
    title: ReactNode;
};
export declare function Section({ actions, children, className, count, title, ...props }: SectionProps): import("react").JSX.Element;
export type PanelTone = 'default' | 'danger';
export type PanelHeaderPresentation = 'muted' | 'bordered';
export type PanelProps = Omit<ComponentPropsWithoutRef<'section'>, 'title'> & {
    actions?: ReactNode;
    bodyClassName?: string;
    description?: ReactNode;
    headerPresentation?: PanelHeaderPresentation;
    padded?: boolean;
    title: ReactNode;
    tone?: PanelTone;
};
export declare function Panel({ actions, bodyClassName, children, className, description, headerPresentation, padded, title, tone, ...props }: PanelProps): import("react").JSX.Element;
type Icon = ComponentType<{
    className?: string;
}>;
export type EmptyStateProps = Omit<ComponentPropsWithoutRef<'div'>, 'title'> & {
    actions?: ReactNode;
    description?: ReactNode;
    icon?: Icon;
    title?: ReactNode;
};
export declare function EmptyState({ actions, children, className, description, icon: IconComponent, title, ...props }: EmptyStateProps): import("react").JSX.Element;
export type DataTableHeader = {
    align?: 'left' | 'right';
    className?: string;
    colSpan?: number;
    label?: ReactNode;
};
export type DataTableProps = Omit<HTMLAttributes<HTMLDivElement>, 'children'> & {
    children: ReactNode;
    headers: readonly DataTableHeader[];
    label?: string;
    minWidth?: string;
    panel?: boolean;
    tableClassName?: string;
};
export declare function DataTable({ children, className, headers, label, minWidth, panel, tableClassName, ...props }: DataTableProps): import("react").JSX.Element;
export type EntityProps = Omit<ComponentPropsWithoutRef<'div'>, 'title'> & {
    description?: ReactNode;
    initials?: string;
    mono?: boolean;
    title: ReactNode;
};
export declare function Entity({ className, description, initials, mono, title, ...props }: EntityProps): import("react").JSX.Element;
export type CardProps = ComponentPropsWithoutRef<'div'> & {
    muted?: boolean;
    padded?: boolean;
};
export declare function Card({ className, muted, padded, ...props }: CardProps): import("react").JSX.Element;
export {};
