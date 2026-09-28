'use client';

import { useId } from 'react';
import { useTranslations } from 'next-intl';
import { GripVertical, RotateCcw, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/motion/button';
import { CenterMorphModal, CenterMorphModalContent } from '@/components/motion/center-morph-modal';
import { Checkbox } from '@/components/motion/checkbox';

export function ComposerToolbarCustomizer({
  open, onOpenChange, title, resetLabel, options, pinnedIds, onChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  resetLabel: string;
  options: readonly { id: string; label: string; icon: LucideIcon }[];
  pinnedIds: readonly string[];
  onChange: (ids: string[]) => void;
}) {
  const common = useTranslations('common');
  const checkboxId = useId();
  const orderedOptions = [
    ...pinnedIds.flatMap((id) => options.find((option) => option.id === id) ?? []),
    ...options.filter((option) => !pinnedIds.includes(option.id)),
  ];

  function moveShortcut(from: number, to: number) {
    if (from < 0 || to < 0 || to >= pinnedIds.length || from === to) return;
    const next = [...pinnedIds];
    const [id] = next.splice(from, 1);
    next.splice(to, 0, id);
    onChange(next);
  }

  return (
    <CenterMorphModal open={open} onOpenChange={onOpenChange}>
      <CenterMorphModalContent ariaLabel={title} closeButtonLabel={common('close')} className="flex max-h-[calc(100dvh-6rem)] max-w-md flex-col">
        <header className="flex shrink-0 items-center gap-3 border-b border-border pl-5 pr-16 py-4">
          <h2 className="min-w-0 text-lg font-semibold">{title}</h2>
        </header>
        <div className="min-h-0 overflow-y-auto px-5 py-2">
          {orderedOptions.map((option) => {
            const index = pinnedIds.indexOf(option.id);
            const Icon = option.icon;
            return (
              <div key={option.id} draggable={index >= 0}
                onDragStart={(event) => { event.dataTransfer.setData('text/plain', option.id); event.dataTransfer.effectAllowed = 'move'; }}
                onDragOver={(event) => { if (index >= 0) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; } }}
                onDrop={(event) => { event.preventDefault(); moveShortcut(pinnedIds.indexOf(event.dataTransfer.getData('text/plain')), index); }}
                onKeyDown={(event) => {
                  if (!event.altKey || index < 0) return;
                  const offset = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
                  if (offset && index + offset >= 0 && index + offset < pinnedIds.length) {
                    event.preventDefault();
                    moveShortcut(index, index + offset);
                  }
                }}
                className={`flex min-h-14 items-center gap-2 border-b border-border py-2 last:border-b-0 ${index >= 0 ? 'cursor-grab active:cursor-grabbing' : ''}`}>
                <GripVertical aria-hidden className={`size-4 shrink-0 ${index >= 0 ? 'text-muted-foreground' : 'invisible'}`} />
                <Checkbox id={`${checkboxId}-${option.id}`} className="shrink-0" checked={index >= 0} aria-label={option.label}
                  onCheckedChange={(checked) => onChange(checked ? [...pinnedIds, option.id] : pinnedIds.filter((id) => id !== option.id))} />
                <label htmlFor={`${checkboxId}-${option.id}`} className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                  <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                  <span className="break-words text-sm text-foreground">{option.label}</span>
                </label>
              </div>
            );
          })}
        </div>
        <footer className="flex shrink-0 justify-end border-t border-border px-5 py-4">
          <Button type="button" disabled={!pinnedIds.length} onClick={() => onChange([])} variant="secondary" size="sm"><RotateCcw className="size-3.5" />{resetLabel}</Button>
        </footer>
      </CenterMorphModalContent>
    </CenterMorphModal>
  );
}
