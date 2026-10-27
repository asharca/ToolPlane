"use client";

import { useTranslations } from "next-intl";
import { useActionState, useEffect, useState } from "react";
import { Button, ButtonLink } from "@/components/motion/button";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import {
  configurePiPackageAction,
  type PiPackageSetupState,
} from "@/lib/market/pi-package-setup-action";

type Requirement = { key: string; name: string; tools: string[] };
type Variable = { id: string; name: string; value: string };
type Choice = {
  source: string;
  config: string;
  variables: Variable[];
  envRemove: string;
};
type AgentOption = {
  id: string;
  name: string;
  currentRevisionId: string | null;
  sandboxes: Array<{ sandboxId: string }>;
};
type DeploymentOption = {
  id: string;
  name: string;
  status: string;
  requiredEnvironment?: string[];
};
type ReleaseOption = {
  id: string;
  name: string;
  version: number;
  requiredEnvironment?: string[];
};
type SandboxOption = {
  id: string;
  name: string;
  status?: string;
  network?: string;
};
const emptyChoice: Choice = {
  source: "",
  config: "",
  variables: [],
  envRemove: "",
};

export function PiPackageSetupWizard({
  workspace,
  releaseId,
  requirements,
  agents,
  deployments,
  marketMcpReleases,
  sandboxes,
}: {
  workspace: string;
  releaseId: string;
  requirements: Requirement[];
  agents: AgentOption[];
  deployments: DeploymentOption[];
  marketMcpReleases: ReleaseOption[];
  sandboxes: SandboxOption[];
}) {
  const t = useTranslations("console.market");
  const [state, action, pending] = useActionState(
    configurePiPackageAction,
    {} as PiPackageSetupState,
  );
  const [agentId, setAgentId] = useState("");
  const [sandboxId, setSandboxId] = useState("");
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const [inputError, setInputError] = useState(false);
  const [applyConfirmed, setApplyConfirmed] = useState(false);
  useEffect(() => setIdempotencyKey(crypto.randomUUID()), []);
  const agent = agents.find((item) => item.id === agentId);
  const availableSandboxes = agent
    ? sandboxes.filter((sandbox) =>
        agent.sandboxes.some((item) => item.sandboxId === sandbox.id),
      )
    : sandboxes;
  const needsSandbox = requirements.length > 0 && agent?.sandboxes.length !== 1;
  const errors: Record<string, string> = {
    not_authorized: "setupUnauthorized",
    notAuthorized: "setupUnauthorized",
    invalid_request: "setupFailed",
    pi_package_executable_confirmation_required:
      "setupExecutableConsentRequired",
    pi_package_privileges_confirmation_required:
      "setupPrivilegesConsentRequired",
    pi_package_invalid_bindings: "setupInvalidMcpBindings",
    pi_package_mcp_binding_required: "setupInvalidMcpBindings",
    agent_not_found: "setupAgentUnavailable",
    agent_revision_preparation_required: "setupAgentRevisionRequired",
    agent_revision_conflict: "setupAgentRevisionConflict",
    agent_revision_apply_confirmation_required: "setupApplyConsentRequired",
    sandboxRequired: "setupSandboxRequired",
    sandboxNotFound: "setupSandboxUnavailable",
    sandboxNotRunning: "setupSandboxNotRunning",
    sandboxNetworkDisabled: "setupSandboxNetworkDisabled",
    deploymentNotRunning: "setupMcpNotRunning",
    authenticationFailed: "setupAuthenticationFailed",
    deploymentNotFound: "setupMcpUnavailable",
    credentialsRequired: "setupMcpCredentialsRequired",
    connectorFailed: "setupMcpTestFailed",
    configuration_not_saved: "setupInvalidMcpConfig",
    shared_connection_configuration_required:
      "setupSharedConnectionConfigurationRequired",
    package_platform_mismatch: "piPlatformMismatch",
    listing_unavailable: "piUnavailable",
    pi_package_agent_busy: "setupAgentBusy",
    setup_failed: "setupFailed",
  };
  function updateChoice(key: string, patch: Partial<Choice>) {
    setApplyConfirmed(false);
    setChoices((current) => ({
      ...current,
      [key]: { ...emptyChoice, ...current[key], ...patch },
    }));
  }
  function chooseSource(key: string, source: string) {
    const [type, id] = source.split(":", 2);
    const selected =
      type === "deployment"
        ? deployments.find((item) => item.id === id)
        : marketMcpReleases.find((item) => item.id === id);
    updateChoice(key, {
      source,
      config: "",
      envRemove: "",
      variables:
        type === "release"
          ? (selected?.requiredEnvironment ?? []).map((name) => ({
              id: crypto.randomUUID(),
              name,
              value: "",
            }))
          : [],
    });
    setIdempotencyKey(crypto.randomUUID());
  }
  function prepareSubmission(form: HTMLFormElement) {
    const encoded = requirements.map((requirement) => {
      const choice = choices[requirement.key] ?? emptyChoice;
      const [type, id] = choice.source.split(":", 2);
      const set: Record<string, string> = {};
      for (const variable of choice.variables) {
        if (!variable.value) continue;
        const name = variable.name.trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || name in set)
          throw new Error("invalid_environment");
        set[name] = variable.value;
      }
      const remove = choice.envRemove
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean);
      if (remove.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)))
        throw new Error("invalid_environment");
      return {
        key: requirement.key,
        ...(type === "deployment" ? { deploymentId: id } : { releaseId: id }),
        ...(choice.config.trim() ? { config: choice.config } : {}),
        ...(Object.keys(set).length || remove.length
          ? { changes: { set, remove } }
          : {}),
      };
    });
    const input = form.elements.namedItem("mcps");
    if (input instanceof HTMLInputElement)
      input.value = JSON.stringify(encoded);
  }
  return (
    <form
      action={action}
      onSubmit={(event) => {
        setInputError(false);
        try {
          prepareSubmission(event.currentTarget);
        } catch {
          event.preventDefault();
          setInputError(true);
        }
      }}
      className="space-y-4 rounded-lg border border-border p-4"
    >
      <input type="hidden" name="workspace" value={workspace} />
      <input type="hidden" name="releaseId" value={releaseId} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <input type="hidden" name="mcps" defaultValue="[]" />
      <input
        type="hidden"
        name="expectedRevisionId"
        value={agent?.currentRevisionId ?? ""}
      />
      <header className="space-y-1">
        <h3 className="font-semibold">{t("setupWizardTitle")}</h3>
        <p className="text-xs leading-5 text-muted-foreground">
          {t("setupWizardDescription")}
        </p>
      </header>
      <label className="block space-y-1 text-sm">
        <span>{t("setupAgentOptional")}</span>
        <select
          name="agentId"
          value={agentId}
          disabled={pending}
          onChange={(event) => {
            setAgentId(event.target.value);
            setSandboxId("");
            setApplyConfirmed(false);
          }}
          className="w-full rounded-md border border-border bg-background px-3 py-2"
        >
          <option value="">{t("setupWorkspaceOnly")}</option>
          {agents.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      {agent ? (
        <section className="space-y-3 rounded-md border border-border p-3 text-sm">
          {agent.currentRevisionId ? (
            <>
              <p>{t("setupApplyReview")}</p>
              <p className="break-all font-mono text-xs">
                {agent.currentRevisionId}
              </p>
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  name="confirmApplyToAgent"
                  value="yes"
                  required
                  checked={applyConfirmed}
                  disabled={pending}
                  onChange={(event) => setApplyConfirmed(event.target.checked)}
                  className="mt-1 size-4"
                />
                <span>{t("setupApplyConsent")}</span>
              </label>
            </>
          ) : (
            <p role="status">{t("setupAgentRevisionRequired")}</p>
          )}
          <ButtonLink
            href={`/app/${encodeURIComponent(workspace)}/agents/${encodeURIComponent(agent.id)}`}
            variant="ghost"
            size="sm"
          >
            {t("setupAgentSettingsLink")}
          </ButtonLink>
        </section>
      ) : null}
      {needsSandbox ? (
        <label className="block space-y-1 text-sm">
          <span>{t("setupSandbox")}</span>
          <select
            name="sandboxId"
            required
            value={sandboxId}
            disabled={pending || !availableSandboxes.length}
            onChange={(event) => setSandboxId(event.target.value)}
            className="w-full rounded-md border border-border bg-background px-3 py-2"
          >
            <option value="">{t("setupChooseSandbox")}</option>
            {availableSandboxes.map((sandbox) => (
              <option key={sandbox.id} value={sandbox.id}>
                {sandbox.name}
                {sandbox.status ? ` · ${sandbox.status}` : ""}
              </option>
            ))}
          </select>
          {!availableSandboxes.length ? (
            <span className="block text-xs text-muted-foreground">
              {t("setupNoSandbox")}
            </span>
          ) : null}
        </label>
      ) : null}
      {requirements.length ? (
        <div className="space-y-2 text-xs text-muted-foreground">
          <p>{t("setupSandboxPrerequisites")}</p>
          <div className="flex flex-wrap gap-2">
            <ButtonLink
              href={`/app/${encodeURIComponent(workspace)}/sandboxes`}
              variant="ghost"
              size="sm"
            >
              {t("setupManageSandbox")}
            </ButtonLink>
            {agentId ? (
              <ButtonLink
                href={`/app/${encodeURIComponent(workspace)}/agents/${encodeURIComponent(agentId)}?settings=sandboxes`}
                variant="ghost"
                size="sm"
              >
                {t("setupAgentSettingsLink")}
              </ButtonLink>
            ) : null}
          </div>
        </div>
      ) : null}
      {requirements.length ? (
        <fieldset className="space-y-3 rounded-lg border border-border p-3">
          <legend className="px-1 text-sm font-medium">
            {t("setupMcpRequirements")}
          </legend>
          <p className="rounded border border-border bg-muted/40 p-3 text-xs">
            {t("setupSharedMcpWarning")}
          </p>
          {requirements.map((requirement) => {
            const choice = choices[requirement.key] ?? emptyChoice;
            return (
              <section
                key={requirement.key}
                className="space-y-3 rounded-md border border-border p-3"
              >
                <h4 className="text-sm font-medium">{requirement.name}</h4>
                <p className="text-xs text-muted-foreground">
                  {t("setupRequiredTools", {
                    tools: requirement.tools.join(", "),
                  })}
                </p>
                <label className="block space-y-1 text-sm">
                  <span>{t("setupMcpSource")}</span>
                  <select
                    required
                    value={choice.source}
                    disabled={pending}
                    onChange={(event) =>
                      chooseSource(requirement.key, event.target.value)
                    }
                    className="w-full rounded-md border border-border bg-background px-3 py-2"
                  >
                    <option value="">{t("setupChooseMcp")}</option>
                    {deployments.map((item) => (
                      <option key={item.id} value={`deployment:${item.id}`}>
                        {t("setupExistingMcp", {
                          name: item.name,
                          status: item.status,
                        })}
                      </option>
                    ))}
                    {marketMcpReleases.map((item) => (
                      <option key={item.id} value={`release:${item.id}`}>
                        {t("setupMarketMcp", {
                          name: item.name,
                          version: item.version,
                        })}
                      </option>
                    ))}
                  </select>
                </label>
                {choice.source.startsWith("deployment:") ? (
                  <div className="space-y-2 text-xs text-muted-foreground">
                    <p>{t("setupSharedConnectionConfigurationRequired")}</p>
                    <ButtonLink
                      href={`/app/${encodeURIComponent(workspace)}/mcp/${encodeURIComponent(choice.source.slice("deployment:".length))}`}
                      variant="ghost"
                      size="sm"
                    >
                      {t("setupSharedConnectionSettings")}
                    </ButtonLink>
                  </div>
                ) : choice.source.startsWith("release:") ? (
                  <>
                    <fieldset className="space-y-2">
                      <legend className="text-sm font-medium">
                        {t("setupMcpEnv")}
                      </legend>
                      <p className="text-xs text-muted-foreground">
                        {t("setupEnvValueHelp")}
                      </p>
                      {choice.variables.map((variable) => (
                        <div
                          key={variable.id}
                          className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]"
                        >
                          <label className="min-w-0 space-y-1 text-xs">
                            <span>{t("setupEnvKey")}</span>
                            <input
                              value={variable.name}
                              pattern="[A-Za-z_][A-Za-z0-9_]*"
                              required={Boolean(variable.value)}
                              disabled={pending}
                              onChange={(event) =>
                                updateChoice(requirement.key, {
                                  variables: choice.variables.map((item) =>
                                    item.id === variable.id
                                      ? { ...item, name: event.target.value }
                                      : item,
                                  ),
                                })
                              }
                              className="w-full rounded border border-border bg-background px-2 py-2"
                            />
                          </label>
                          <label className="min-w-0 space-y-1 text-xs">
                            <span>{t("setupEnvValue")}</span>
                            <input
                              type="password"
                              autoComplete="new-password"
                              value={variable.value}
                              disabled={pending}
                              onChange={(event) =>
                                updateChoice(requirement.key, {
                                  variables: choice.variables.map((item) =>
                                    item.id === variable.id
                                      ? { ...item, value: event.target.value }
                                      : item,
                                  ),
                                })
                              }
                              className="w-full rounded border border-border bg-background px-2 py-2"
                            />
                          </label>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={pending}
                            onClick={() =>
                              updateChoice(requirement.key, {
                                variables: choice.variables.filter(
                                  (item) => item.id !== variable.id,
                                ),
                              })
                            }
                          >
                            {t("setupRemoveEnvRow")}
                          </Button>
                        </div>
                      ))}
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        disabled={pending || !choice.source}
                        onClick={() =>
                          updateChoice(requirement.key, {
                            variables: [
                              ...choice.variables,
                              { id: crypto.randomUUID(), name: "", value: "" },
                            ],
                          })
                        }
                      >
                        {t("setupAddEnv")}
                      </Button>
                    </fieldset>
                    <details className="space-y-2">
                      <summary className="cursor-pointer text-sm">
                        {t("setupMcpConfig")}
                      </summary>
                      <label className="block space-y-1 text-xs">
                        <span>{t("setupMcpConfig")}</span>
                        <textarea
                          value={choice.config}
                          disabled={pending}
                          onChange={(event) =>
                            updateChoice(requirement.key, {
                              config: event.target.value,
                            })
                          }
                          rows={3}
                          className="w-full resize-y rounded border border-border bg-background px-3 py-2 font-mono"
                        />
                      </label>
                      <label className="block space-y-1 text-xs">
                        <span>{t("setupMcpEnvRemove")}</span>
                        <input
                          value={choice.envRemove}
                          disabled={pending}
                          onChange={(event) =>
                            updateChoice(requirement.key, {
                              envRemove: event.target.value,
                            })
                          }
                          className="w-full rounded border border-border bg-background px-3 py-2"
                        />
                      </label>
                    </details>
                  </>
                ) : null}
              </section>
            );
          })}
        </fieldset>
      ) : null}
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          name="confirmExecutableCode"
          value="yes"
          required
          disabled={pending}
          className="mt-1 size-4"
        />
        <span>{t("setupExecutableConsent")}</span>
      </label>
      {requirements.length ? (
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            name="confirmExpandedPrivileges"
            value="yes"
            required
            disabled={pending}
            className="mt-1 size-4"
          />
          <span>{t("setupPrivilegesConsent")}</span>
        </label>
      ) : null}
      {state.error ? (
        <p role="alert" className="text-sm text-destructive">
          {t(errors[state.error] ?? "setupFailed")}
        </p>
      ) : null}
      {state.error === "shared_connection_configuration_required" ? (
        <ButtonLink
          href={`/app/${encodeURIComponent(workspace)}/mcp`}
          variant="ghost"
          size="sm"
        >
          {t("setupSharedConnectionSettings")}
        </ButtonLink>
      ) : null}
      {inputError ? (
        <p role="alert" className="text-sm text-destructive">
          {t("setupInvalidMcpConfig")}
        </p>
      ) : null}
      {state.status || state.marketInstallId ? (
        <div
          role="status"
          className="space-y-1 rounded bg-muted/40 p-3 text-xs"
        >
          <p className="font-medium">
            {t(state.status === "complete" ? "setupComplete" : "setupPartial")}
          </p>
          {state.deployments?.map((item) => (
            <p key={`${item.key}:${item.deploymentId}`}>
              {item.key} · {item.deploymentId} ·{" "}
              {t(`setupStatus${item.status}`)}
            </p>
          ))}
          {state.marketInstallId ? (
            <p>{t("setupWorkspaceInstallCreated")}</p>
          ) : null}
          {state.agentId && state.enabled && state.agentRevisionId ? (
            <p>
              {t("setupAgentEnabled", {
                agent:
                  agents.find((item) => item.id === state.agentId)?.name ??
                  state.agentId,
                revision: state.agentRevisionId,
              })}
            </p>
          ) : null}
          {state.status === "partial" ? (
            <p>{t("setupNoRollbackClaim")}</p>
          ) : null}
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <SubmitButton
          disabled={
            pending ||
            !idempotencyKey ||
            (Boolean(agent) &&
              (!agent?.currentRevisionId || !applyConfirmed)) ||
            (needsSandbox && !availableSandboxes.length)
          }
          pendingLabel={t("setupInProgress")}
          variant="primary"
          size="sm"
        >
          {t(agentId ? "setupApplyToAgent" : "setupInstallWorkspace")}
        </SubmitButton>
      </div>
    </form>
  );
}
