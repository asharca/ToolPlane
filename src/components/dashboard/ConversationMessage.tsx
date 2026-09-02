'use client';

import { Bot } from 'lucide-react';
import {
  forwardRef,
  lazy,
  Suspense,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from 'react';
import { SafeStreamdown } from '@/components/dashboard/SafeStreamdown';
import { hasMermaidFence } from '@toolplane/ui';

const MermaidAssistantMarkdown = lazy(() => import('./MermaidAssistantMarkdown'));

export const assistantMessageActionClassName = 'flex size-[26px] items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40';

export const assistantMarkdownClassName = 'space-y-2 [&_li]:my-0.5 [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-1 [&_pre]:my-2 [&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-5';

export function ConversationPendingIndicator({
  label,
  className,
}: {
  label: string;
  className?: string;
}) {
  return (
    <div
      role="status"
      data-ui="conversation-pending"
      className={`flex items-center gap-2 text-[13px] text-muted-foreground ${className ?? 'py-2.5 pl-10'}`}
    >
      <span>{label}</span>
      <span aria-hidden="true" className="flex items-center gap-1">
        <span data-ui="conversation-pending-dot" className="size-1 animate-bounce rounded-full bg-current [animation-delay:-300ms]" />
        <span data-ui="conversation-pending-dot" className="size-1 animate-bounce rounded-full bg-current [animation-delay:-150ms]" />
        <span data-ui="conversation-pending-dot" className="size-1 animate-bounce rounded-full bg-current" />
      </span>
    </div>
  );
}

export function AssistantMarkdown({
  text,
  streaming = false,
}: {
  text: string;
  streaming?: boolean;
}) {
  if (hasMermaidFence(text)) {
    return (
      <Suspense fallback={<PlainAssistantMarkdown text={text} streaming={streaming} />}>
        <MermaidAssistantMarkdown
          text={text}
          streaming={streaming}
          className={assistantMarkdownClassName}
        />
      </Suspense>
    );
  }
  return <PlainAssistantMarkdown text={text} streaming={streaming} />;
}

function PlainAssistantMarkdown({
  text,
  streaming,
}: {
  text: string;
  streaming: boolean;
}) {
  return (
    <SafeStreamdown
      mode={streaming ? 'streaming' : 'static'}
      parseIncompleteMarkdown={streaming}
      isAnimating={streaming}
      preserveSoftBreaks
      linkSafety={{ enabled: true }}
      className={assistantMarkdownClassName}
    >
      {text}
    </SafeStreamdown>
  );
}

type AssistantReplyProps = Omit<ComponentPropsWithoutRef<'article'>, 'children'> & {
  agentName: string;
  children?: ReactNode;
  actions?: ReactNode;
  streaming?: boolean;
  placeholder?: ReactNode;
};

export const AssistantReply = forwardRef<HTMLElement, AssistantReplyProps>(function AssistantReply({
  agentName,
  children,
  actions,
  streaming = false,
  placeholder,
  className,
  ...props
}, ref) {
  return (
    <article
      ref={ref}
      {...props}
      aria-busy={streaming || undefined}
      data-streaming={streaming || undefined}
      data-ui="assistant-reply"
      className={`group/message flex items-start justify-start gap-2.5 rounded-[10px] pt-2.5${className ? ` ${className}` : ''}`}
    >
      <div className="flex size-[30px] shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Bot className="size-[15px]" />
      </div>
      <div className="min-w-0 max-w-[calc(100%_-_2.5rem)] flex-1">
        <div className="text-sm font-semibold leading-5 text-foreground">{agentName}</div>
        <div className="mt-2 min-w-0 break-words text-sm leading-[1.65] text-foreground" aria-live={streaming ? 'polite' : undefined}>
          {children ?? (streaming ? placeholder : null)}
        </div>
        {actions ? <div className="mt-1 min-h-[26px]">{actions}</div> : null}
      </div>
    </article>
  );
});
