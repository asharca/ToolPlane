import { type StreamdownProps } from 'streamdown';
export type SafeStreamdownProps = StreamdownProps & {
    preserveSoftBreaks?: boolean;
};
export declare function SafeStreamdown({ allowElement, components, disallowedElements, preserveSoftBreaks, remarkPlugins, ...props }: SafeStreamdownProps): import("react").JSX.Element;
