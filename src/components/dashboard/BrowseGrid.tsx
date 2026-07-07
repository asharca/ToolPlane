import { getTranslations } from 'next-intl/server';
type BrowseItem = {
  id: string;
  name: string;
  description: string | null;
  iconUrl: string | null;
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
  installedLabel,
}: {
  items: BrowseItem[];
  installedIds: Set<string>;
  slug: string;
  action: (formData: FormData) => void | Promise<void>;
  idField: string;
  actionLabel: string;
  installedLabel: string;
}) {
  const t = await getTranslations('console.common');
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((it) => (
        <div
          key={it.id}
          className="ui-panel flex flex-col p-4"
        >
          <div className="mb-2 flex items-center gap-2.5">
            {it.iconUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={it.iconUrl}
                alt=""
                width={20}
                height={20}
                className="size-5 rounded object-cover"
              />
            ) : (
              <span className="size-5 rounded bg-muted" />
            )}
            <span className="font-medium text-foreground">{it.name}</span>
          </div>
          <p className="mb-4 line-clamp-2 flex-1 text-sm text-muted-foreground">
            {it.description}
          </p>
          {installedIds.has(it.id) ? (
            <span className="ui-button-secondary ui-button-sm w-fit text-muted-foreground">
              {installedLabel}
            </span>
          ) : it.deployable === false ? (
            <span className="inline-flex min-h-8 w-fit items-center rounded-md border border-dashed border-border px-3 text-sm text-muted-foreground">
              {t('demoOnly')}
            </span>
          ) : (
            <form action={action}>
              <input type="hidden" name="workspace" value={slug} />
              <input type="hidden" name={idField} value={it.id} />
              <button className="ui-button-primary ui-button-sm">
                {actionLabel}
              </button>
            </form>
          )}
        </div>
      ))}
    </div>
  );
}
