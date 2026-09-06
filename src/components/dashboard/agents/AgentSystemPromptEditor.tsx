'use client';

import { useState } from 'react';
import { Eye, Loader2, Pencil, RotateCcw, Sparkles } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { AssistantMarkdown } from '@/components/dashboard/ConversationMessage';
import { estimatePromptTokens } from '@/lib/prompt-tokens';

export function AgentSystemPromptEditor({
  workspaceId,
  name,
  description,
  providerId,
  model,
  value,
  onChange,
  fieldName = 'systemPrompt',
}: {
  workspaceId: string;
  name: string;
  description?: string;
  providerId: string;
  model: string;
  value: string;
  onChange: (value: string) => void;
  fieldName?: string;
}) {
  const t = useTranslations('console.agents');
  const [preview, setPreview] = useState(Boolean(value.trim()));
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restore, setRestore] = useState<{ previous: string; generated: string } | null>(null);
  const canGenerate = Boolean(workspaceId && name.trim() && providerId && model);

  async function generatePrompt() {
    if (!canGenerate || generating) return;
    setGenerating(true);
    setError(null);
    try {
      const response = await fetch('/api/v1/chat/assistants/generate-prompt', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          name: name.trim(),
          description: description?.trim() || null,
          systemPrompt: value.trim() || null,
          modelProviderId: providerId,
          model,
        }),
      });
      const body = await response.json().catch(() => ({})) as { prompt?: string; error?: string };
      if (!response.ok || !body.prompt?.trim()) throw new Error(body.error || t('promptGenerationError'));
      const generated = body.prompt.trim();
      setRestore({ previous: value, generated });
      onChange(generated);
      setPreview(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('promptGenerationError'));
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <span className="block text-xs font-semibold text-foreground">{t('systemPrompt')}</span>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            {t('estimatedTokens', { count: estimatePromptTokens(value) })}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          {value.trim() ? (
            <button
              type="button"
              aria-label={preview ? t('editSystemPrompt') : t('previewSystemPrompt')}
              title={preview ? t('editSystemPrompt') : t('previewSystemPrompt')}
              onClick={() => setPreview((current) => !current)}
              className="ui-button-ghost ui-icon-button"
            >
              {preview ? <Pencil className="size-4" /> : <Eye className="size-4" />}
            </button>
          ) : null}
          <button
            type="button"
            disabled={!canGenerate || generating}
            onClick={generatePrompt}
            className="ui-button-secondary h-8 gap-1.5 px-2.5 text-xs disabled:cursor-not-allowed disabled:opacity-50"
          >
            {generating ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
            {value.trim() ? t('improvePrompt') : t('generatePrompt')}
          </button>
        </div>
      </div>

      {preview ? (
        <>
          <input type="hidden" name={fieldName} value={value} />
          <div role="region" aria-label={t('previewSystemPrompt')} className="min-h-52 rounded-md border border-border bg-muted/20 px-4 py-3">
            <AssistantMarkdown text={value} />
          </div>
        </>
      ) : (
        <textarea
          name={fieldName}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          rows={10}
          maxLength={100_000}
          placeholder={t('youAreAHelpfulAssistant')}
          className="ui-input min-h-56 w-full resize-y py-3"
          aria-label={t('systemPrompt')}
        />
      )}

      {restore ? (
        <button
          type="button"
          onClick={() => {
            onChange(restore.previous);
            setRestore(null);
            setPreview(false);
          }}
          className="ui-button-ghost h-8 gap-1.5 px-2 text-xs"
        >
          <RotateCcw className="size-3.5" />
          {t('restorePreviousPrompt')}
        </button>
      ) : null}
      {error ? <p role="alert" className="text-xs text-red-600 dark:text-red-300">{error}</p> : null}
    </div>
  );
}
