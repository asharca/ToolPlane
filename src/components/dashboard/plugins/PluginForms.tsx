"use client";

import { useActionState, useEffect, useId, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/motion/button";
import { FormSelect } from "@/components/ui/FormSelect";
import { pluginAction, type PluginActionState } from "@/lib/plugins/actions";

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
}: {
  workspace: string;
  operation: string;
  id?: string;
  children?: React.ReactNode;
  label: string;
  destructive?: boolean;
  confirm?: boolean;
}) {
  const t = useTranslations("console.plugins");
  const resetAllowed = useRef(false);
  const [state, action, pending] = useActionState<PluginActionState, FormData>(
    async (previous, form) => {
      resetAllowed.current = false;
      const result = await pluginAction(previous, form);
      resetAllowed.current = Boolean(result.success);
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
        variant="secondary"
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

export type PluginReleaseOption = {
  id: string;
  version: string;
  requirements: Array<{ key: string; name: string; tools: string[] }>;
};

export function PluginInstallForm({
  workspace,
  listingId,
  installId,
  releases,
  currentReleaseId,
  deployments,
  defaults,
}: {
  workspace: string;
  listingId: string;
  installId?: string;
  releases: PluginReleaseOption[];
  currentReleaseId?: string;
  deployments: Array<{ id: string; name: string; tools: string[] }>;
  defaults: Record<string, { deploymentId: string; tools: string[] }>;
}) {
  const t = useTranslations("console.plugins");
  const fieldId = useId();
  const [releaseId, setReleaseId] = useState(releases[0]?.id ?? "");
  const [bindings, setBindings] = useState(defaults);
  const [state, action, pending] = useActionState<PluginActionState, FormData>(
    pluginAction,
    {},
  );
  useEffect(() => {
    if (state.success) window.dispatchEvent(new Event("plugins-changed"));
  }, [state]);
  const release = releases.find((item) => item.id === releaseId);
  if (!release) return null;
  const selectedBindings = Object.fromEntries(
    release.requirements.flatMap((requirement) => {
      const binding = bindings[requirement.key];
      return binding
        ? [
            [
              requirement.key,
              { deploymentId: binding.deploymentId, tools: requirement.tools },
            ],
          ]
        : [];
    }),
  );
  const ready = release.requirements.every((requirement) =>
    deployments.some(
      (deployment) =>
        deployment.id === bindings[requirement.key]?.deploymentId &&
        requirement.tools.every((tool) => deployment.tools.includes(tool)),
    ),
  );
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="workspace" value={workspace} />
      <input
        type="hidden"
        name="operation"
        value={installId ? "update" : "add"}
      />
      <input type="hidden" name="id" value={installId ?? listingId} />
      <input type="hidden" name="releaseId" value={release.id} />
      <input
        type="hidden"
        name="mcpBindings"
        value={JSON.stringify(selectedBindings)}
      />
      {installId ? (
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
                  ? `${item.version} · ${t("currentVersion")}`
                  : item.version,
            }))}
          />
        </div>
      ) : null}
      {release.requirements.length ? (
        <fieldset className="space-y-3">
          <legend className="mb-2 text-sm font-medium">
            {t("mcpBindings")}
          </legend>
          {release.requirements.map((requirement) => {
            const eligible = deployments.filter((deployment) =>
              requirement.tools.every((tool) =>
                deployment.tools.includes(tool),
              ),
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
                  required
                  value={selected}
                  disabled={pending}
                  onValueChange={(value) =>
                    setBindings((previous) => ({
                      ...previous,
                      [requirement.key]: {
                        deploymentId: value,
                        tools: requirement.tools,
                      },
                    }))
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
      ) : null}
      <Button
        type="submit"
        size="sm"
        disabled={pending || !ready || release.id === currentReleaseId}
      >
        {pending ? t("working") : t(installId ? "update" : "add")}
      </Button>
      <PluginResult state={state} />
    </form>
  );
}

export function PluginSourceCreate({ workspace }: { workspace: string }) {
  const t = useTranslations("console.plugins");
  const fieldId = useId();
  const [visibility, setVisibility] = useState("public");
  return (
    <PluginActionForm
      workspace={workspace}
      operation="source-add"
      label={t("sourceAdd")}
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
