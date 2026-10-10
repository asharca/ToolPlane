"use client";
import { Input } from "@/components/motion/input";

import { useTranslations } from "next-intl";
import { useActionState, useId } from "react";
import { Plus, Save } from "lucide-react";
import {
  createCategoryAction,
  deleteCategoryAction,
  updateCategoryAction,
} from "@/lib/admin/category-actions";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import { AdminBadge, AdminPanel } from "@/components/admin/AdminUI";
import { ConfirmDialog } from "@/components/admin/ConfirmDialog";
import type { AdminActionState } from "@/lib/admin/user-actions";

type Row = {
  id: string;
  slug: string;
  name: string;
  _count: {
    servers: number;
    skills: number;
    clients: number;
    agentListings: number;
    assistants: number;
    toolkits: number;
  };
};

function CategoryRow({ category }: { category: Row }) {
  const t = useTranslations("admin");
  const fieldId = useId();
  const [state, action] = useActionState<AdminActionState, FormData>(
    updateCategoryAction,
    {},
  );

  return (
    <li className="px-5 py-4">
      <div className="flex min-w-0 flex-col items-start gap-3 2xl:flex-row">
        <form
          action={action}
          className="flex min-w-0 flex-1 flex-wrap items-center gap-3"
        >
          <input type="hidden" name="categoryId" value={category.id} />
          <label htmlFor={`${fieldId}-name`} className="min-w-0 flex-1">
            <span className="sr-only">
              {t("categoryNameLabel", { slug: category.slug })}
            </span>
            <Input
              id={`${fieldId}-name`}
              name="name"
              defaultValue={category.name}
              maxLength={120}
              required
            />
          </label>
          <code className="shrink-0 font-mono text-xs text-muted-foreground">
            /{category.slug}
          </code>
          <div className="flex flex-wrap gap-1.5 text-xs text-muted-foreground">
            <AdminBadge tone="neutral">
              MCP {category._count.servers}
            </AdminBadge>
            <AdminBadge tone="neutral">
              {t("skills")} {category._count.skills}
            </AdminBadge>
            <AdminBadge tone="neutral">
              {t("agents")} {category._count.agentListings}
            </AdminBadge>
            <AdminBadge tone="neutral">
              {t("assistants")} {category._count.assistants}
            </AdminBadge>
            <AdminBadge tone="neutral">
              {t("toolkits")} {category._count.toolkits}
            </AdminBadge>
            <AdminBadge tone="neutral">
              {t("clients")} {category._count.clients}
            </AdminBadge>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <SubmitButton
              error={state.error}
              pendingLabel={t("saving")}
              savedLabel={t("saved")}
              variant="secondary"
              size="md"
            >
              <Save className="size-4" />
              {t("saveChanges")}
            </SubmitButton>
          </div>
        </form>
        <ConfirmDialog
          label={t("delete")}
          ariaLabel={t("deleteCategoryLabel", { name: category.name })}
          prompt={t("deleteCategoryConfirm", { name: category.name })}
          action={deleteCategoryAction}
          hidden={{ categoryId: category.id }}
          pendingLabel={t("deleting")}
          tone="danger"
        />
      </div>
      {state.error ? (
        <p className="mt-2 text-sm text-destructive" role="alert">
          {state.error}
        </p>
      ) : null}
    </li>
  );
}

export function CategoriesPanel({ categories }: { categories: Row[] }) {
  const t = useTranslations("admin");
  const fieldId = useId();
  const [state, action] = useActionState<AdminActionState, FormData>(
    createCategoryAction,
    {},
  );

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(17rem,22rem)_minmax(0,1fr)]">
      <AdminPanel title={t("add")}>
        <form action={action} className="space-y-4">
          <label
            htmlFor={`${fieldId}-name`}
            className="block space-y-1.5 text-sm font-medium text-foreground"
          >
            <span>{t("name")}</span>
            <Input
              id={`${fieldId}-name`}
              name="name"
              placeholder={t("name")}
              required
            />
          </label>
          <label
            htmlFor={`${fieldId}-slug`}
            className="block space-y-1.5 text-sm font-medium text-foreground"
          >
            <span>{t("slug3")}</span>
            <Input
              id={`${fieldId}-slug`}
              name="slug"
              placeholder={t("slug3")}
              autoCapitalize="none"
              spellCheck={false}
              required
            />
          </label>
          <SubmitButton
            error={state.error}
            pendingLabel={t("adding")}
            savedLabel={t("added")}
            variant="primary"
            size="md"
            className="w-full sm:w-auto"
          >
            <Plus className="size-4" />
            {t("add")}
          </SubmitButton>
          {state.error ? (
            <p className="text-sm text-destructive" role="alert">
              {state.error}
            </p>
          ) : null}
        </form>
      </AdminPanel>

      <AdminPanel
        title={t("categories")}
        description={t("categoryAssociationCountsDescription")}
        actions={<AdminBadge tone="neutral">{categories.length}</AdminBadge>}
        padded={false}
      >
        {categories.length > 0 ? (
          <ul className="divide-y divide-border">
            {categories.map((category) => (
              <CategoryRow key={category.id} category={category} />
            ))}
          </ul>
        ) : (
          <p className="px-5 py-10 text-center text-sm text-muted-foreground">
            {t("none")}
          </p>
        )}
      </AdminPanel>
    </div>
  );
}
