import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { CheckCircle2, ChevronRight } from 'lucide-react';
import { SubmitButton } from '@/components/dashboard/SubmitButton';

type BrowseItem = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  iconUrl: string | null;
  author?: string | null;
  githubSource?: string | null;
  curated?: boolean;
  categories?: { name: string; slug: string }[];
  // When explicitly false the item is not deployable (no verified recipe) and
  // the action is replaced by a disabled "Demo only" marker. Undefined (e.g. for
  // skills, which are always installable) leaves the action enabled.
  deployable?: boolean;
};

export async function BrowseGrid({
  items,
  installedIds,
  slug,
  action,
  idField,
  actionLabel,
  pendingLabel,
  installedLabel,
  detailKind,
}: {
  items: BrowseItem[];
  installedIds: Set<string>;
  slug: string;
  action: (formData: FormData) => void | Promise<void>;
  idField: string;
  actionLabel: string;
  pendingLabel: string;
  installedLabel: string;
  detailKind: 'mcp' | 'skills';
}) {
  const [common, market] = await Promise.all([
    getTranslations('console.common'),
    getTranslations('console.market'),
  ]);
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {items.map((it) => (
        <article
          key={it.id}
          className="ui-panel flex min-w-0 flex-col p-4"
        >
          <div className="flex min-w-0 items-start gap-3">
            {it.iconUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={it.iconUrl}
                alt=""
                width={40}
                height={40}
                className="size-10 shrink-0 rounded-lg object-cover"
              />
            ) : (
              <span
                aria-hidden="true"
                className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-sm font-semibold text-muted-foreground"
              >
                {Array.from(it.name.trim())[0]?.toUpperCase() ?? 'S'}
              </span>
            )}
            <div className="min-w-0 flex-1">
              <Link
                href={`/app/${encodeURIComponent(slug)}/market/${detailKind}/${encodeURIComponent(it.slug)}`}
                className="line-clamp-1 font-semibold text-foreground hover:underline"
              >
                {it.name}
              </Link>
              {it.author !== undefined ? (
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  {it.author ?? market('unknownPublisher')}
                </p>
              ) : null}
            </div>
          </div>

          <p className="mt-3 line-clamp-2 min-h-10 flex-1 text-sm leading-5 text-muted-foreground">
            {it.description ?? market('noDescription')}
          </p>

          {it.githubSource || it.curated || it.categories?.length ? (
            <div className="mt-3 flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
              <span className="rounded bg-muted px-2 py-1">
                {it.githubSource ? market('github') : it.curated ? market('curated') : market('catalog')}
              </span>
              {it.categories?.slice(0, 2).map((category) => (
                <span key={category.slug} className="rounded bg-muted px-2 py-1">{category.name}</span>
              ))}
            </div>
          ) : null}

          <div className="mt-4 grid grid-cols-2 gap-2 border-t border-border pt-4">
            <Link
              href={`/app/${encodeURIComponent(slug)}/market/${detailKind}/${encodeURIComponent(it.slug)}`}
              className="ui-button-secondary h-9 min-w-0 px-3"
            >
              {market('viewDetails')}
              <ChevronRight className="size-3.5" aria-hidden="true" />
            </Link>
            {installedIds.has(it.id) ? (
              <span className="ui-button-secondary h-9 min-w-0 text-emerald-700 dark:text-emerald-400">
                <CheckCircle2 className="size-3.5" aria-hidden="true" />
                {installedLabel}
              </span>
            ) : it.deployable === false ? (
              <span className="inline-flex h-9 min-w-0 items-center justify-center rounded-md border border-dashed border-border px-3 text-sm text-muted-foreground">
                {common('demoOnly')}
              </span>
            ) : (
              <form action={action} className="min-w-0">
                <input type="hidden" name="workspace" value={slug} />
                <input type="hidden" name={idField} value={it.id} />
                <SubmitButton
                  flash={false}
                  pendingLabel={pendingLabel}
                  className="ui-button-primary h-9 w-full min-w-0 px-3"
                >
                  {actionLabel}
                </SubmitButton>
              </form>
            )}
          </div>
        </article>
      ))}
    </div>
  );
}
