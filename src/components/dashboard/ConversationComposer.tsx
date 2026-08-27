'use client';

import { useCallback, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Maximize2, Minimize2, Paperclip, Plus, X } from 'lucide-react';
import { Popover, Tooltip } from 'radix-ui';
import type { ContextUsageSnapshot } from '@/lib/context-usage';

export const conversationComposerClassName = 'group/composer relative rounded-[20px] border-[0.5px] border-border bg-card pt-2 shadow-sm transition-all duration-200 ease-in-out hover:border-foreground/25 focus-within:border-foreground/25';

export const conversationComposerToolbarClassName = 'relative z-[2] flex h-10 items-center justify-between gap-4 px-2 py-[5px]';

export const conversationAttachmentThumbClassName = 'flex size-[18px] shrink-0 items-center justify-center rounded-[5px] bg-background text-[9px] font-semibold uppercase text-muted-foreground';

export function conversationComposerInputClassName(expanded: boolean) {
  return `block min-h-[46px] w-full resize-none overflow-y-auto bg-transparent pb-0 pl-[15px] pr-11 pt-1.5 text-sm leading-[1.4] text-foreground outline-none transition-none placeholder:text-muted-foreground disabled:opacity-60 [&::-webkit-scrollbar]:w-[3px] ${expanded ? 'max-h-[max(220px,50vh)]' : 'max-h-[max(220px,40vh)]'}`;
}

export function useConversationComposerExpansion() {
  const [minRows, setMinRows] = useState(2);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const expanded = minRows > 2;

  function toggle() {
    setMinRows(expanded
      ? 2
      : Math.ceil((Math.max(220, window.innerHeight * 0.5) - 6) / (14 * 1.4)));
    inputRef.current?.focus();
  }

  return { expanded, inputRef, minRows, toggle };
}

export function ConversationComposerExpand({
  expanded,
  onToggle,
}: {
  expanded: boolean;
  onToggle: () => void;
}) {
  const t = useTranslations('console.agents');
  const Icon = expanded ? Minimize2 : Maximize2;
  const label = t(expanded ? 'restoreComposer' : 'expandComposer');

  return (
    <div className="absolute right-px top-px z-10 size-8">
      <span
        aria-hidden="true"
        className="pointer-events-none absolute right-1 top-1 size-3 origin-top-right scale-100 rounded-tr-[16px] border-r-[1.5px] border-t-[1.5px] border-foreground/60 opacity-70 transition-[opacity,scale] duration-200 ease-out group-focus-within/composer:scale-50 group-focus-within/composer:opacity-0 group-hover/composer:scale-50 group-hover/composer:opacity-0"
      />
      <button
        type="button"
        onClick={onToggle}
        aria-label={label}
        title={label}
        aria-pressed={expanded}
        className="pointer-events-none absolute right-1 top-1 flex size-[22px] -translate-y-2.5 translate-x-2.5 rotate-[-8deg] scale-80 items-center justify-center rounded-full bg-transparent text-muted-foreground opacity-0 transition-[opacity,translate,scale,rotate,color,background-color] duration-300 ease-out hover:bg-muted hover:text-foreground focus-visible:pointer-events-auto focus-visible:translate-x-0 focus-visible:translate-y-0 focus-visible:rotate-0 focus-visible:scale-100 focus-visible:bg-muted focus-visible:text-foreground focus-visible:opacity-100 group-focus-within/composer:pointer-events-auto group-focus-within/composer:translate-x-0 group-focus-within/composer:translate-y-0 group-focus-within/composer:rotate-0 group-focus-within/composer:scale-100 group-focus-within/composer:bg-muted/80 group-focus-within/composer:text-foreground group-focus-within/composer:opacity-100 group-hover/composer:pointer-events-auto group-hover/composer:translate-x-0 group-hover/composer:translate-y-0 group-hover/composer:rotate-0 group-hover/composer:scale-100 group-hover/composer:bg-muted/80 group-hover/composer:text-foreground group-hover/composer:opacity-100"
      >
        <Icon className="size-3 transition-transform duration-300 ease-out group-focus-within/composer:scale-110 group-hover/composer:scale-110" />
      </button>
    </div>
  );
}

function contextUsageColor(percentage: number) {
  if (percentage <= 50) {
    return `color-mix(in oklch, hsl(var(--brand)) ${100 - percentage * 2}%, #facc15 ${percentage * 2}%)`;
  }
  return `color-mix(in oklch, #facc15 ${200 - percentage * 2}%, hsl(var(--destructive)) ${(percentage - 50) * 2}%)`;
}

export function ConversationContextUsage({
  busy = false,
  usage,
}: {
  busy?: boolean;
  usage: ContextUsageSnapshot | null;
}) {
  const t = useTranslations('console.agents');
  if (!usage) return null;
  const percentage = Math.round(Math.min(100, Math.max(0, usage.usedTokens / usage.maxTokens * 100)));
  const color = contextUsageColor(percentage);
  const label = t('contextUsage');

  return (
    <Tooltip.Provider delayDuration={150}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <span
            role="meter"
            tabIndex={0}
            aria-label={`${label} ${percentage}%`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percentage}
            aria-busy={busy || undefined}
            className={`relative inline-grid size-5 shrink-0 place-items-center rounded-full ${busy ? 'animate-pulse' : ''}`}
            style={{ background: `conic-gradient(${color} ${percentage}%, hsl(var(--border)) 0)` }}
          >
            <span aria-hidden="true" className="absolute inset-0.5 rounded-full bg-card" />
          </span>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            side="top"
            sideOffset={8}
            collisionPadding={12}
            className="z-50 w-64 rounded-lg border border-border bg-popover p-3 text-xs text-popover-foreground shadow-lg"
          >
            <p className="font-medium text-foreground">{label}</p>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className={busy ? 'h-full animate-pulse rounded-full' : 'h-full rounded-full'}
                style={{ width: `${percentage}%`, background: color } as CSSProperties}
              />
            </div>
            <div className="mt-2 flex items-center justify-between gap-3 text-muted-foreground">
              <span className="shrink-0">
                {usage.estimated ? '≈ ' : ''}{usage.usedTokens.toLocaleString()} / {usage.maxTokens.toLocaleString()} ({percentage}%)
              </span>
              <span className="min-w-0 truncate">{usage.modelName}</span>
            </div>
            {usage.estimated ? <p className="mt-1.5 text-[11px] text-muted-foreground">{t('contextUsageEstimated')}</p> : null}
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}

export function ConversationAttachmentChip({
  name,
  progress,
  removeButton,
  thumbnail,
}: {
  name: ReactNode;
  progress?: number;
  removeButton: ReactNode;
  thumbnail: ReactNode;
}) {
  return (
    <div className="mx-0.5 my-0.5 inline-flex h-6 max-w-[calc(100%_-_0.25rem)] items-center gap-1 overflow-hidden rounded-md border border-border bg-muted/50 px-1.5 text-xs font-medium text-foreground">
      {thumbnail}
      <span className="max-w-48 truncate">{name}</span>
      {progress !== undefined ? <span className="text-muted-foreground">{Math.round(progress * 100)}%</span> : null}
      {removeButton}
    </div>
  );
}

export function ConversationAttachmentRemoveButton({
  label,
  onClick,
}: {
  label: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="flex size-4 shrink-0 items-center justify-center rounded-[5px] text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      <X className="size-3" />
    </button>
  );
}

export function ConversationAttachmentPicker({
  accept = '*',
  disabled,
  onFiles,
  supportsAttachments,
}: {
  accept?: string;
  disabled: boolean;
  onFiles: (files: File[]) => void;
  supportsAttachments: boolean;
}) {
  const t = useTranslations('console.agents');
  const openPicker = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.hidden = true;
    if (accept !== '*') input.accept = accept;
    const removeInput = () => input.remove();
    input.onchange = () => {
      onFiles(Array.from(input.files ?? []));
      removeInput();
    };
    input.oncancel = removeInput;
    document.body.appendChild(input);
    input.click();
  }, [accept, onFiles]);

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={t('openComposerTools')}
          title={t('openComposerTools')}
          className="flex size-[30px] shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
        >
          <Plus className="size-[18px]" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          aria-label={t('composerTools')}
          className="z-50 w-64 rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-xl"
        >
          <Popover.Close asChild>
            <button
              type="button"
              disabled={!supportsAttachments}
              onClick={openPicker}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Paperclip className="size-4 shrink-0" />
              <span className="min-w-0">
                <span className="block">{t('addAttachment')}</span>
                {!supportsAttachments ? (
                  <span className="mt-0.5 block text-[11px] text-muted-foreground">{t('attachmentRuntimeRequired')}</span>
                ) : null}
              </span>
            </button>
          </Popover.Close>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
