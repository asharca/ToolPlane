"use client";

import { useActionState, useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Plus } from "lucide-react";
import { Button, type ButtonVariant } from "@/components/motion/button";
import {
  CenterMorphModal,
  CenterMorphModalContent,
  CenterMorphModalTrigger,
} from "@/components/motion/center-morph-modal";
import { DialogBody, DialogHeader } from "@/components/dashboard/dialog";
import { notify } from "@/components/dashboard/Toaster";
import { FormSelect } from "@/components/ui/FormSelect";
import { pluginAction, type PluginActionState } from "@/lib/plugins/actions";
import type { PluginBindingDeployment } from "@/lib/plugins/binding-deployments";

const pluginFieldClass =
  "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm";

export function PluginActionForm({
  workspace,
  operation,
  id,
  children,
  label,
  destructive = false,
  confirm = false,
  variant = "secondary",
  onSuccess,
}: {
  workspace: string;
  operation: string;
  id?: string;
  children?: React.ReactNode;
  label: string;
  destructive?: boolean;
  confirm?: boolean;
  variant?: ButtonVariant;
  onSuccess?: () => void;
}) {
  const t = useTranslations("console.plugins");
  const resetAllowed = useRef(false);
  const [state, action, pending] = useActionState<PluginActionState, FormData>(
    async (previous, form) => {
      resetAllowed.current = false;
      const result = await pluginAction(previous, form);
      resetAllowed.current = Boolean(result.success);
      if (result.success) onSuccess?.();
      return result;
    },
    {},
  );
  useEffect(() => {
    if (state.success) window.dispatchEvent(new Event("plugins-changed"));
  }, [state]);
  return (
    <form
      action={action}
      onResetCapture={(event) => {
        if (!resetAllowed.current) {
          event.preventDefault();
          // Radix resets its controlled value in a native form listener.
          event.stopPropagation();
        }
      }}
      onSubmit={(event) => {
        if (confirm && !window.confirm(t("confirmRemove")))
          event.preventDefault();
      }}
      className="space-y-3"
    >
      <input type="hidden" name="workspace" value={workspace} />
      <input type="hidden" name="operation" value={operation} />
      <input type="hidden" name="id" value={id ?? ""} />
      {children}
      <Button
        type="submit"
        variant={variant}
        className={destructive ? "text-destructive" : undefined}
        size="sm"
        disabled={pending}
      >
        {pending ? t("working") : label}
      </Button>
      <PluginResult state={state} />
    </form>
  );
}

function PluginResult({ state }: { state: PluginActionState }) {
  const t = useTranslations("console.plugins");
  if (state.error)
    return (
      <p role="alert" className="text-sm text-destructive">
        {t.has(`errors.${state.error}`)
          ? t(`errors.${state.error}`)
          : t("errors.operation_failed")}
      </p>
    );
  return state.success ? (
    <p role="status" className="text-sm text-muted-foreground">
      {t("saved")}
    </p>
  ) : null;
}

/** Inline add for plugins without MCP requirements; the card re-renders after revalidation. */
export function PluginQuickAdd({
  workspace,
  listingId,
  name,
}: {
  workspace: string;
  listingId: string;
  name: string;
}) {
  const t = useTranslations("console.plugins");
  const [, action, pending] = useActionState<PluginActionState, FormData>(
    async (previous, form) => {
      const result = await pluginAction(previous, form);
      if (result.success) {
        window.dispatchEvent(new Event("plugins-changed"));
        notify(t("addedToast", { name }));
      } else
        notify(
          t.has(`errors.${result.error}`)
            ? t(`errors.${result.error}`)
            : t("errors.operation_failed"),
          { severity: "error" },
        );
      return result;
    },
    {},
  );
  return (
    <form action={action} className="relative z-10">
      <input type="hidden" name="workspace" value={workspace} />
      <input type="hidden" name="operation" value="add" />
      <input type="hidden" name="id" value={listingId} />
      <input type="hidden" name="mcpBindings" value="{}" />
      <Button type="submit" size="sm" variant="secondary" disabled={pending}>
        {pending ? t("working") : t("quickAdd")}
      </Button>
    </form>
  );
}

/** Applies one list filter on change while keeping the other list params. */
export function PluginListFilter({
  base,
  params,
  name,
  label,
  value,
  options,
}: {
  base: string;
  params: Record<string, string>;
  name: string;
  label: string;
  value: string;
  /** Include the empty "all" option first. */
  options: Array<{ value: string; label: string }>;
}) {
  const router = useRouter();
  return (
    <FormSelect
      key={value}
      label={label}
      defaultValue={value}
      className="w-full sm:w-44"
      onValueChange={(next) => {
        const query = new URLSearchParams(
          Object.entries(params).filter(([key, item]) => item && key !== name),
        );
        if (next) query.set(name, next);
        const search = query.toString();
        router.push(search ? `${base}?${search}` : base);
      }}
      options={options}
    />
  );
}

export type PluginMcpRequirement = {
  key: string;
  name: string;
  tools: string[];
};
export type PluginReleaseOption = {
  id: string;
  version: string;
  requirements: PluginMcpRequirement[];
};
export type PluginBindingDraft = Record<
  string,
  { deploymentId: string; tools: string[] }
>;

/** Submitted bindings for one release, and whether every requirement has an eligible deployment. */
export function pluginBindingState(
  requirements: PluginMcpRequirement[],
  deployments: PluginBindingDeployment[],
  bindings: PluginBindingDraft,
) {
  return {
    selected: Object.fromEntries(
      requirements.flatMap((requirement) => {
        const binding = bindings[requirement.key];
        return binding
          ? [
              [
                requirement.key,
                {
                  deploymentId: binding.deploymentId,
                  tools: requirement.tools,
                },
              ],
            ]
          : [];
      }),
    ),
    ready: requirements.every((requirement) =>
      deployments.some(
        (deployment) =>
          deployment.id === bindings[requirement.key]?.deploymentId &&
          requirement.tools.every((tool) => deployment.tools.includes(tool)),
      ),
    ),
  };
}

/** One select per MCP requirement, offering only deployments that expose all its tools. */
export function PluginMcpBindingFields({
  requirements,
  deployments,
  bindings,
  onChange,
  disabled,
  required = false,
}: {
  requirements: PluginMcpRequirement[];
  deployments: PluginBindingDeployment[];
  bindings: PluginBindingDraft;
  onChange: (next: PluginBindingDraft) => void;
  disabled?: boolean;
  /** Native validation; leave off inside a larger form that has other submit paths. */
  required?: boolean;
}) {
  const t = useTranslations("console.plugins");
  const fieldId = useId();
  return (
    <fieldset className="space-y-3">
      <legend className="mb-2 text-sm font-medium">{t("mcpBindings")}</legend>
      {requirements.map((requirement) => {
        const eligible = deployments.filter((deployment) =>
          requirement.tools.every((tool) => deployment.tools.includes(tool)),
        );
        const selected = eligible.some(
          (item) => item.id === bindings[requirement.key]?.deploymentId,
        )
          ? bindings[requirement.key]?.deploymentId
          : "";
        const bindingId = `${fieldId}-binding-${encodeURIComponent(requirement.key)}`;
        return (
          <div key={requirement.key} className="grid gap-1 text-sm">
            <label htmlFor={bindingId}>{requirement.name}</label>
            <span className="break-all font-mono text-xs text-muted-foreground">
              {requirement.tools.join(", ")}
            </span>
            <FormSelect
              id={bindingId}
              label={requirement.name}
              required={required}
              value={selected}
              disabled={disabled}
              onValueChange={(value) =>
                onChange({
                  ...bindings,
                  [requirement.key]: {
                    deploymentId: value,
                    tools: requirement.tools,
                  },
                })
              }
              options={[
                { value: "", label: t("selectMcp") },
                ...eligible.map((deployment) => ({
                  value: deployment.id,
                  label: deployment.name,
                })),
              ]}
            />
            {!eligible.length ? (
              <span className="text-destructive">{t("noMcp")}</span>
            ) : null}
          </div>
        );
      })}
    </fieldset>
  );
}

/** Action card body: add, update, switch version and remove for one plugin. */
export function PluginInstallForm({
  workspace,
  listingId,
  install,
  releases,
  deployments,
  defaults,
  canManage,
  status,
}: {
  workspace: string;
  listingId: string;
  install?: { id: string; releaseId: string; version: string };
  releases: PluginReleaseOption[];
  deployments: PluginBindingDeployment[];
  defaults: PluginBindingDraft;
  canManage: boolean;
  /** Listing status: published, withdrawn or removed. */
  status: string;
}) {
  const t = useTranslations("console.plugins");
  const published = status === "published";
  const latest = canManage && published ? releases[0] : undefined;
  const installed = install
    ? t("addedVersion", { version: install.version })
    : t("notAdded");
  return (
    <div className="space-y-4">
      {!latest ? (
        <p role="status" className="text-sm font-medium">
          {installed}
          {!published ? (
            <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-xs font-normal text-muted-foreground">
              {t(status === "withdrawn" ? "withdrawn" : "removed")}
            </span>
          ) : null}
        </p>
      ) : !install ? (
        <PluginReleaseForm
          workspace={workspace}
          operation="add"
          id={listingId}
          releases={[latest]}
          deployments={deployments}
          defaults={defaults}
          submitLabel={() => t("add")}
        />
      ) : install.releaseId !== latest.id ? (
        <>
          <p className="text-sm font-medium">
            v{install.version} → v{latest.version}
          </p>
          <PluginReleaseForm
            workspace={workspace}
            operation="update"
            id={install.id}
            releases={[latest]}
            deployments={deployments}
            defaults={defaults}
            submitLabel={(version) => t("updateTo", { version })}
          />
        </>
      ) : (
        <>
          <p role="status" className="text-sm font-medium">
            {t("upToDate", { version: install.version })}
          </p>
          {releases.length > 1 ? (
            <details className="rounded-lg border border-border px-3 py-2">
              <summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground">
                {t("switchVersion")}
              </summary>
              <div className="mt-3">
                <PluginReleaseForm
                  workspace={workspace}
                  operation="update"
                  id={install.id}
                  releases={releases}
                  currentReleaseId={install.releaseId}
                  deployments={deployments}
                  defaults={defaults}
                  submitLabel={() => t("switchToVersion")}
                />
              </div>
            </details>
          ) : null}
        </>
      )}
      {install && canManage ? (
        <div className="border-t border-border pt-3">
          <PluginActionForm
            workspace={workspace}
            operation="remove"
            id={install.id}
            label={t("remove")}
            variant="ghost"
            destructive
            confirm
          />
        </div>
      ) : null}
    </div>
  );
}

function PluginReleaseForm({
  workspace,
  operation,
  id,
  releases,
  currentReleaseId,
  deployments,
  defaults,
  submitLabel,
}: {
  workspace: string;
  operation: "add" | "update";
  id: string;
  releases: PluginReleaseOption[];
  /** Set when choosing among versions; the current one cannot be resubmitted. */
  currentReleaseId?: string;
  deployments: PluginBindingDeployment[];
  defaults: PluginBindingDraft;
  submitLabel: (version: string) => string;
}) {
  const t = useTranslations("console.plugins");
  const fieldId = useId();
  const [releaseId, setReleaseId] = useState(
    currentReleaseId ?? releases[0]?.id ?? "",
  );
  const [bindings, setBindings] = useState(defaults);
  const [state, action, pending] = useActionState<PluginActionState, FormData>(
    async (previous, form) => {
      const result = await pluginAction(previous, form);
      if (result.success) {
        window.dispatchEvent(new Event("plugins-changed"));
        notify(t("saved"));
      }
      return result;
    },
    {},
  );
  const release = releases.find((item) => item.id === releaseId);
  if (!release) return null;
  const { selected: selectedBindings, ready } = pluginBindingState(
    release.requirements,
    deployments,
    bindings,
  );
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="workspace" value={workspace} />
      <input type="hidden" name="operation" value={operation} />
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="releaseId" value={release.id} />
      <input
        type="hidden"
        name="mcpBindings"
        value={JSON.stringify(selectedBindings)}
      />
      {currentReleaseId ? (
        <div className="grid gap-1 text-sm">
          <label htmlFor={`${fieldId}-release`}>{t("version")}</label>
          <FormSelect
            id={`${fieldId}-release`}
            label={t("version")}
            value={releaseId}
            onValueChange={setReleaseId}
            disabled={pending}
            options={releases.map((item) => ({
              value: item.id,
              label:
                item.id === currentReleaseId
                  ? `v${item.version} · ${t("currentVersion")}`
                  : `v${item.version}`,
            }))}
          />
        </div>
      ) : null}
      {release.requirements.length ? (
        <PluginMcpBindingFields
          requirements={release.requirements}
          deployments={deployments}
          bindings={bindings}
          onChange={setBindings}
          disabled={pending}
          required
        />
      ) : null}
      <Button
        type="submit"
        className="w-full"
        disabled={pending || !ready || release.id === currentReleaseId}
      >
        {pending ? t("working") : submitLabel(release.version)}
      </Button>
      {state.error ? <PluginResult state={state} /> : null}
    </form>
  );
}

export function PluginSourceCreate({
  workspace,
  onSuccess,
}: {
  workspace: string;
  onSuccess?: () => void;
}) {
  const t = useTranslations("console.plugins");
  const fieldId = useId();
  const [visibility, setVisibility] = useState("public");
  return (
    <PluginActionForm
      workspace={workspace}
      operation="source-add"
      label={t("sourceAdd")}
      variant="primary"
      onSuccess={onSuccess}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1 text-sm">
          {t("name")}
          <input
            className={pluginFieldClass}
            name="name"
            required
            maxLength={120}
          />
        </label>
        <label className="grid gap-1 text-sm">
          {t("repository")}
          <input
            className={pluginFieldClass}
            name="repository"
            required
            placeholder="owner/repository"
          />
        </label>
        <label className="grid gap-1 text-sm">
          {t("branch")}
          <input
            className={pluginFieldClass}
            name="branch"
            defaultValue="main"
            required
          />
        </label>
        <div className="grid gap-1 text-sm">
          <label htmlFor={fieldId}>{t("visibility")}</label>
          <FormSelect
            id={fieldId}
            name="visibility"
            label={t("visibility")}
            value={visibility}
            onValueChange={setVisibility}
            options={[
              { value: "public", label: t("public") },
              { value: "private", label: t("private") },
            ]}
          />
        </div>
      </div>
      <label className="grid gap-1 text-sm">
        {t("token")}
        <input
          type="password"
          className={pluginFieldClass}
          name="token"
          required={visibility === "private"}
          autoComplete="off"
          maxLength={4096}
        />
      </label>
    </PluginActionForm>
  );
}

export function PluginSourceCreateDialog({ workspace }: { workspace: string }) {
  const t = useTranslations("console.plugins");
  const common = useTranslations("common");
  const [open, setOpen] = useState(false);
  return (
    <CenterMorphModal open={open} onOpenChange={setOpen}>
      <CenterMorphModalTrigger>
        <Button type="button" variant="primary" size="md">
          <Plus className="size-4" />
          {t("sourceAdd")}
        </Button>
      </CenterMorphModalTrigger>
      <CenterMorphModalContent
        ariaLabel={t("sourceAdd")}
        closeButtonLabel={common("close")}
        className="flex max-h-[calc(100dvh-4rem)] w-full max-w-xl flex-col"
      >
        <DialogHeader title={t("sourceAdd")} />
        <DialogBody>
          <PluginSourceCreate
            workspace={workspace}
            onSuccess={() => {
              setOpen(false);
              notify(t("sourceAdded"));
            }}
          />
        </DialogBody>
      </CenterMorphModalContent>
    </CenterMorphModal>
  );
}

export function PluginWebhook({
  path,
  secret,
}: {
  path: string;
  secret: string;
}) {
  const t = useTranslations("console.plugins");
  const [shown, setShown] = useState(false);
  const [origin, setOrigin] = useState("");
  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);
  return (
    <div className="space-y-3 text-sm">
      <label className="grid gap-1">
        {t("webhookUrl")}
        <input
          readOnly
          className={pluginFieldClass}
          value={`${origin}${path}`}
          onFocus={(event) => event.currentTarget.select()}
        />
      </label>
      <div className="flex items-end gap-2">
        <label className="grid min-w-0 flex-1 gap-1">
          {t("webhookSecret")}
          <input
            readOnly
            type={shown ? "text" : "password"}
            className={pluginFieldClass}
            value={secret}
            onFocus={(event) => event.currentTarget.select()}
          />
        </label>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => setShown(!shown)}
        >
          {t(shown ? "hide" : "show")}
        </Button>
      </div>
    </div>
  );
}
