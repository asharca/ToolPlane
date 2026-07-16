'use client';

import { useTranslations } from 'next-intl';
import { useActionState } from 'react';
import { Download, FolderGit2 } from 'lucide-react';
import { importSkillFromGithubAction } from '@/lib/admin/market-actions';
import { SubmitButton } from '@/components/dashboard/SubmitButton';
import { AdminPage, AdminPageHeader, AdminPanel } from '@/components/admin/AdminUI';
import type { AdminActionState } from '@/lib/admin/user-actions';

export default function ImportSkillPage() {
  const t = useTranslations('admin');
  const [state, formAction] = useActionState<AdminActionState, FormData>(importSkillFromGithubAction, {});

  return (
    <AdminPage className="max-w-4xl">
      <AdminPageHeader
        title={t('importSkillBundle')}
        backHref="/admin/skills"
        backLabel={t('skills')}
      />

      <AdminPanel
        title={t('githubSource')}
        description={(
          <>
            {t('importsTheWholeFolder')} <code className="font-mono text-foreground">SKILL.md</code>
            {t('referencesScriptsAndOtherTextFilesFrontmatterSuppliesNameDescriptionAndAuthor')}
          </>
        )}
      >
        <form action={formAction} className="max-w-3xl space-y-5">
          <label className="block space-y-1.5 text-sm font-medium text-foreground">
            <span className="inline-flex items-center gap-2">
              <FolderGit2 className="size-4 text-muted-foreground" />
              {t('githubSource')}
            </span>
            <input
              name="githubSource"
              required
              placeholder="owner/repo/path/to/skill or https://github.com/owner/repo/tree/main/path"
              className="ui-input h-11 font-mono"
              autoFocus
              autoCapitalize="none"
              spellCheck={false}
            />
          </label>

          <div className="border-t border-border pt-4">
            <p className="text-xs font-semibold text-foreground">{t('examples')}</p>
            <ul className="mt-2 space-y-2 font-mono text-xs text-muted-foreground">
              <li className="break-all rounded-md bg-muted/55 px-3 py-2">{t('anthropicsskillsskillspdf')}</li>
              <li className="break-all rounded-md bg-muted/55 px-3 py-2">
                https://github.com/anthropics/skills/tree/main/skills/pdf
              </li>
              <li className="break-all rounded-md bg-muted/55 px-3 py-2">
                {t('openaiskillsskillscuratedplaywright')}
              </li>
            </ul>
          </div>

          <div className="flex flex-col items-start gap-3 border-t border-border pt-5 sm:flex-row sm:items-center">
            <SubmitButton
              pendingLabel={t('importing')}
              error={state.error}
              className="ui-button-primary h-11 w-full sm:w-auto"
            >
              <Download className="size-4" />
              {t('importSkill')}
            </SubmitButton>
            {state.error ? (
              <p className="text-sm text-destructive-text" role="alert">{state.error}</p>
            ) : null}
          </div>
        </form>
      </AdminPanel>
    </AdminPage>
  );
}
