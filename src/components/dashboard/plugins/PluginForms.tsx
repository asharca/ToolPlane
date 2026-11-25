"use client";

import { useActionState, useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { Plus } from "lucide-react";
import { Button, type ButtonVariant } from "@/components/motion/button";
import {
  CenterMorphModal,
  CenterMorphModalContent,
  CenterMorphModalTrigger,
} from "@/components/motion/center-morph-modal";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/motion/collapsible";
import { ConfirmSubmitButton } from "@/components/dashboard/ConfirmSubmitButton";
import { CopyButton } from "@/components/dashboard/CopyButton";
import {
  DialogBody,
  DialogCancel,
  DialogFooter,
  DialogHeader,
} from "@/components/dashboard/dialog";
import { notify } from "@/components/dashboard/Toaster";
import { FormCheckbox } from "@/components/ui/FormCheckbox";
import { FormSelect } from "@/components/ui/FormSelect";
import { pluginAction, type PluginActionState } from "@/lib/plugins/actions";
import type { PluginBindingDeployment } from "@/lib/plugins/binding-deployments";
import {
  envValueKind,
  isEnvRequired,
  isEnvSecret,
  type PluginEnvSourceMode,
  type PluginEnvStatus,
} from "@/lib/plugins/env-schema";

export type PluginEnvDraft = {
  mode: PluginEnvSourceMode;
  values: Record<string, string>;
  clearKeys: string[];
};

export function initialPluginEnvDraft(
  envStatus: PluginEnvStatus | null | undefined,
  customNonSecretValues?: Readonly<Record<string, string>>,
): PluginEnvDraft {
  const mode: PluginEnvSourceMode =
    envStatus?.mode ?? envStatus?.effectiveDefaultMode ?? "custom";
  const values: Record<string, string> = {};
  if (envStatus && customNonSecretValues) {
    for (const item of envStatus.requirements) {
      if (
        !isEnvSecret(item) &&
        typeof customNonSecretValues[item.name] === "string"
      ) {
        values[item.name] = customNonSecretValues[item.name];
      }
    }
  }
  return { mode, values, clearKeys: [] };
}

export function serializePluginEnvDraft(
  envStatus: PluginEnvStatus | null | undefined,
  draft: PluginEnvDraft,
  includeClearKeys: boolean,
) {
  if (!envStatus?.requiresEnv) return undefined;
  if (draft.mode === "platform_preset") {
    return { mode: "platform_preset" as const };
  }
  const values: Record<string, string> = {};
  const byName = new Map(
    envStatus.requirements.map((item) => [item.name, item]),
  );
  for (const [key, raw] of Object.entries(draft.values)) {
    const item = byName.get(key);
    if (!item || draft.clearKeys.includes(key)) continue;
    if (isEnvSecret(item)) {
      if (raw.trim()) values[key] = raw;
    } else if (raw.trim() || includeClearKeys) {
      values[key] = raw;
    }
  }
  return {
    mode: "custom" as const,
    values,
    ...(includeClearKeys && draft.clearKeys.length
      ? { clearKeys: draft.clearKeys }
      : {}),
  };
}

export function isPluginEnvDraftReady(
  envStatus: PluginEnvStatus | null | undefined,
  draft: PluginEnvDraft,
): boolean {
  if (!envStatus?.requiresEnv) return true;
  if (draft.mode === "platform_preset") {
    return envStatus.presetComplete;
  }
  const customSet = new Set(envStatus.customConfiguredKeys);
  const clearSet = new Set(draft.clearKeys);
  for (const item of envStatus.requirements) {
    if (!isEnvRequired(item)) continue;
    const hasExplicit = Object.hasOwn(draft.values, item.name);
    const typed = (draft.values[item.name] ?? "").trim();
    const alreadyConfigured =
      customSet.has(item.name) && !clearSet.has(item.name);
    if (isEnvSecret(item)) {
      if (!typed && !alreadyConfigured) return false;
    } else if (clearSet.has(item.name)) {
      return false;
    } else if (hasExplicit ? !typed : !alreadyConfigured) {
      return false;
    }
  }
  return true;
}

export function PluginEnvFields({
  envStatus,
  draft,
  onChange,
  disabled,
  allowClearKeys = false,
}: {
  envStatus: PluginEnvStatus;
  draft: PluginEnvDraft;
  onChange: (next: PluginEnvDraft) => void;
  disabled?: boolean;
  allowClearKeys?: boolean;
}) {
  const t = useTranslations("console.plugins");
  const fieldId = useId();
  if (!envStatus.requiresEnv) return null;

  const configuredSet = new Set(envStatus.customConfiguredKeys);
  const clearSet = new Set(draft.clearKeys);
  const missingCustom = envStatus.requirements
    .filter((item) => {
      if (!isEnvRequired(item)) return false;
      const hasExplicit = Object.hasOwn(draft.values, item.name);
      const typed = (draft.values[item.name] ?? "").trim();
      const configured =
        configuredSet.has(item.name) && !clearSet.has(item.name);
      if (isEnvSecret(item)) return !typed && !configured;
      if (clearSet.has(item.name)) return true;
      return hasExplicit ? !typed : !configured;
    })
    .map((item) => item.name);

  return (
    <fieldset className="space-y-3">
      <legend className="mb-1 text-sm font-medium">{t("env.title")}</legend>
      {envStatus.presetSupported ? (
        <div className="grid grid-cols-2 gap-1 rounded-lg border border-border p-1">
          {(["platform_preset", "custom"] as const).map((mode) => (
            <Button
              key={mode}
              type="button"
              size="sm"
              variant={draft.mode === mode ? "secondary" : "ghost"}
              disabled={disabled}
              aria-pressed={draft.mode === mode}
              onClick={() => onChange({ ...draft, mode })}
            >
              {t(
                mode === "platform_preset"
                  ? "env.platformPreset"
                  : "env.custom",
              )}
            </Button>
          ))}
        </div>
      ) : null}

      {draft.mode === "platform_preset" ? (
        envStatus.presetComplete ? (
          <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            {t("env.readyPreset")}
          </p>
        ) : (
          <div className="space-y-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs">
            <p className="font-medium text-destructive">
              {t("env.incomplete")}
            </p>
            <p className="font-mono text-destructive">
              {t("env.missingKeys", {
                keys: envStatus.presetMissingRequiredKeys.join(", "),
              })}
            </p>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={disabled}
              onClick={() => onChange({ ...draft, mode: "custom" })}
            >
              {t("env.switchToCustom")}
            </Button>
          </div>
        )
      ) : (
        <div className="space-y-3">
          {envStatus.presetSupported && !envStatus.presetComplete ? (
            <p className="text-xs text-muted-foreground">
              {t("env.noPresetHint")}
            </p>
          ) : null}
          {envStatus.requirements.map((item) => {
            const secret = isEnvSecret(item);
            const required = isEnvRequired(item);
            const configured = configuredSet.has(item.name);
            const markedClear = clearSet.has(item.name);
            const defaultUpstreamUrl = envStatus.httpProxies.find(
              (proxy) => proxy.baseUrlEnv === item.name,
            )?.defaultUpstreamUrl;
            const inputId = `${fieldId}-env-${encodeURIComponent(item.name)}`;

            return (
              <div key={item.name} className="grid gap-1 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label
                    htmlFor={inputId}
                    className="font-mono text-xs font-medium"
                  >
                    {item.name}
                    <span className="ml-1.5 font-sans font-normal text-muted-foreground">
                      · {t(required ? "env.required" : "env.optional")}
                    </span>
                  </label>
                  {configured && !markedClear ? (
                    <span className="text-xs text-muted-foreground">
                      {t("env.configured")}
                    </span>
                  ) : null}
                </div>
                <input
                  id={inputId}
                  type={
                    secret
                      ? "password"
                      : envValueKind(item) === "url"
                        ? "url"
                        : "text"
                  }
                  autoComplete={secret ? "new-password" : "off"}
                  className={`${pluginFieldClass} font-mono`}
                  disabled={disabled || markedClear}
                  value={draft.values[item.name] ?? ""}
                  placeholder={
                    secret && configured
                      ? t("env.secretPlaceholder")
                      : (defaultUpstreamUrl ?? "")
                  }
                  onChange={(event) =>
                    onChange({
                      ...draft,
                      values: {
                        ...draft.values,
                        [item.name]: event.target.value,
                      },
                    })
                  }
                />
                {item.description ? (
                  <p className="text-xs text-muted-foreground">
                    {item.description}
                  </p>
                ) : null}
                {allowClearKeys && configured ? (
                  <FormCheckbox
                    checked={markedClear}
                    disabled={disabled}
                    onCheckedChange={(checked) => {
                      onChange({
                        ...draft,
                        clearKeys: checked
                          ? [...draft.clearKeys, item.name]
                          : draft.clearKeys.filter((k) => k !== item.name),
                      });
                    }}
                    label={t("env.clearKey")}
                  />
                ) : null}
              </div>
            );
          })}
          {missingCustom.length ? (
            <p className="font-mono text-xs text-destructive">
              {t("env.missingKeys", { keys: missingCustom.join(", ") })}
            </p>
          ) : null}
        </div>
      )}
    </fieldset>
  );
}

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
  const common = useTranslations("common");
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
      className="space-y-3"
    >
      <input type="hidden" name="workspace" value={workspace} />
      <input type="hidden" name="operation" value={operation} />
      <input type="hidden" name="id" value={id ?? ""} />
      {children}
      {confirm ? (
        <ConfirmSubmitButton
          triggerLabel={pending ? t("working") : label}
          triggerVariant={variant}
          triggerSize="sm"
          triggerClassName={destructive ? "text-destructive" : undefined}
          confirmLabel={common("confirm")}
          cancelLabel={common("cancel")}
          prompt={t("confirmRemove")}
          pendingLabel={t("working")}
          disabled={pending}
          confirmClassName={
            destructive
              ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
              : undefined
          }
          promptClassName="text-xs text-muted-foreground"
        />
      ) : (
        <Button
          type="submit"
          variant={variant}
          className={destructive ? "text-destructive" : undefined}
          size="sm"
          disabled={pending}
        >
          {pending ? t("working") : label}
        </Button>
      )}
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
  envStatus?: PluginEnvStatus | null;
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
  workspace,
  requirements,
  deployments,
  bindings,
  onChange,
  disabled,
  required = false,
}: {
  workspace?: string;
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
              <span className="text-xs text-destructive">
                {t("noMcp")}
                {workspace ? (
                  <>
                    {" "}
                    <Link
                      href={`/app/${encodeURIComponent(workspace)}/mcp`}
                      className="text-primary hover:underline"
                    >
                      MCP →
                    </Link>
                  </>
                ) : null}
              </span>
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
  envStatus,
  customNonSecretValues,
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
  envStatus?: PluginEnvStatus | null;
  customNonSecretValues?: Readonly<Record<string, string>>;
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
          defaultEnvStatus={envStatus}
          customNonSecretValues={customNonSecretValues}
          submitEnvConfig
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
            defaultEnvStatus={envStatus}
            customNonSecretValues={customNonSecretValues}
            submitEnvConfig={Boolean(
              (latest.envStatus ?? envStatus)?.requiresEnv &&
                !(latest.envStatus ?? envStatus)?.complete,
            )}
            submitLabel={(version) => t("updateTo", { version })}
          />
        </>
      ) : (
        <>
          <p role="status" className="text-sm font-medium">
            {t("upToDate", { version: install.version })}
          </p>
          {releases.length > 1 ? (
            <Collapsible className="rounded-lg border border-border px-3 py-2">
              <CollapsibleTrigger className="px-0 py-1 text-sm text-muted-foreground hover:text-foreground">
                {t("switchVersion")}
              </CollapsibleTrigger>
              <CollapsibleContent className="pt-3">
                <PluginReleaseForm
                  workspace={workspace}
                  operation="update"
                  id={install.id}
                  releases={releases}
                  currentReleaseId={install.releaseId}
                  deployments={deployments}
                  defaults={defaults}
                  defaultEnvStatus={envStatus}
                  customNonSecretValues={customNonSecretValues}
                  submitLabel={() => t("switchToVersion")}
                />
              </CollapsibleContent>
            </Collapsible>
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
  defaultEnvStatus,
  customNonSecretValues,
  submitEnvConfig = false,
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
  defaultEnvStatus?: PluginEnvStatus | null;
  customNonSecretValues?: Readonly<Record<string, string>>;
  submitEnvConfig?: boolean;
  submitLabel: (version: string) => string;
}) {
  const t = useTranslations("console.plugins");
  const fieldId = useId();
  const router = useRouter();
  const [releaseId, setReleaseId] = useState(
    currentReleaseId ?? releases[0]?.id ?? "",
  );
  const [bindings, setBindings] = useState(defaults);
  const initialRelease =
    releases.find(
      (item) => item.id === (currentReleaseId ?? releases[0]?.id),
    ) ?? releases[0];
  const initialEnv = initialRelease?.envStatus ?? defaultEnvStatus ?? null;
  const [envDraft, setEnvDraft] = useState<PluginEnvDraft>(() =>
    initialPluginEnvDraft(initialEnv, customNonSecretValues),
  );
  const [state, action, pending] = useActionState<PluginActionState, FormData>(
    async (previous, form) => {
      const result = await pluginAction(previous, form);
      if (result.success) {
        window.dispatchEvent(new Event("plugins-changed"));
        notify(t("saved"));
        router.refresh();
      }
      return result;
    },
    {},
  );
  const release = releases.find((item) => item.id === releaseId);
  if (!release) return null;
  const releaseEnvStatus = release.envStatus ?? defaultEnvStatus ?? null;
  const showEnvFields = Boolean(
    releaseEnvStatus?.requiresEnv &&
      (submitEnvConfig || !releaseEnvStatus.complete),
  );
  const serializedEnvConfig = showEnvFields
    ? serializePluginEnvDraft(releaseEnvStatus, envDraft, false)
    : undefined;
  const envReady = showEnvFields
    ? isPluginEnvDraftReady(releaseEnvStatus, envDraft)
    : !releaseEnvStatus?.requiresEnv || releaseEnvStatus.complete;
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
      {serializedEnvConfig ? (
        <input
          type="hidden"
          name="envConfig"
          value={JSON.stringify(serializedEnvConfig)}
        />
      ) : null}
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
          workspace={workspace}
          requirements={release.requirements}
          deployments={deployments}
          bindings={bindings}
          onChange={setBindings}
          disabled={pending}
          required
        />
      ) : null}
      {showEnvFields && releaseEnvStatus ? (
        <PluginEnvFields
          envStatus={releaseEnvStatus}
          draft={envDraft}
          onChange={setEnvDraft}
          disabled={pending}
        />
      ) : null}
      <Button
        type="submit"
        className="w-full"
        disabled={
          pending || !ready || !envReady || release.id === currentReleaseId
        }
      >
        {pending ? t("working") : submitLabel(release.version)}
      </Button>
      {state.error ? <PluginResult state={state} /> : null}
    </form>
  );
}

export function PluginEnvConfigPanel({
  workspace,
  installId,
  envStatus,
  customNonSecretValues,
}: {
  workspace: string;
  installId: string;
  envStatus: PluginEnvStatus;
  customNonSecretValues?: Readonly<Record<string, string>>;
}) {
  const t = useTranslations("console.plugins");
  const router = useRouter();
  const [draft, setDraft] = useState<PluginEnvDraft>(() =>
    initialPluginEnvDraft(envStatus, customNonSecretValues),
  );
  const [state, action, pending] = useActionState<PluginActionState, FormData>(
    async (previous, form) => {
      const result = await pluginAction(previous, form);
      if (result.success) {
        setDraft((prev) => {
          const nextValues = { ...prev.values };
          for (const item of envStatus.requirements) {
            if (isEnvSecret(item) || prev.clearKeys.includes(item.name)) {
              delete nextValues[item.name];
            }
          }
          return { ...prev, values: nextValues, clearKeys: [] };
        });
        window.dispatchEvent(new Event("plugins-changed"));
        notify(t("env.saved"));
        router.refresh();
      }
      return result;
    },
    {},
  );
  if (!envStatus.requiresEnv) return null;
  const serialized = serializePluginEnvDraft(envStatus, draft, true);
  return (
    <div className="space-y-3 border-t border-border pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-medium">{t("env.sourceLabel")}</span>
        <span
          className={`rounded-full px-2 py-0.5 text-xs ${envStatus.complete ? "bg-muted text-foreground" : "bg-destructive/10 text-destructive"}`}
        >
          {envStatus.complete
            ? t(
                envStatus.mode === "platform_preset"
                  ? "env.platformPreset"
                  : "env.custom",
              )
            : t("env.incomplete")}
        </span>
      </div>
      {!envStatus.complete && envStatus.missingRequiredKeys.length ? (
        <p className="font-mono text-xs text-destructive">
          {t("env.missingKeys", {
            keys: envStatus.missingRequiredKeys.join(", "),
          })}
        </p>
      ) : null}
      <form action={action} className="space-y-3">
        <input type="hidden" name="workspace" value={workspace} />
        <input type="hidden" name="operation" value="env-update" />
        <input type="hidden" name="id" value={installId} />
        <input
          type="hidden"
          name="envConfig"
          value={JSON.stringify(serialized ?? { mode: draft.mode })}
        />
        <PluginEnvFields
          envStatus={envStatus}
          draft={draft}
          onChange={setDraft}
          disabled={pending}
          allowClearKeys
        />
        <Button type="submit" size="sm" className="w-full" disabled={pending}>
          {pending ? t("working") : t("env.save")}
        </Button>
        {state.error ? <PluginResult state={state} /> : null}
      </form>
    </div>
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
        <DialogFooter cancel={<DialogCancel />} />
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
  const fullUrl = `${origin}${path}`;
  return (
    <div className="space-y-3 text-sm">
      <div className="flex items-end gap-2">
        <label className="grid min-w-0 flex-1 gap-1">
          {t("webhookUrl")}
          <input
            readOnly
            className={pluginFieldClass}
            value={fullUrl}
            onFocus={(event) => event.currentTarget.select()}
          />
        </label>
        <CopyButton text={fullUrl} />
      </div>
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
        <CopyButton text={secret} />
      </div>
    </div>
  );
}
