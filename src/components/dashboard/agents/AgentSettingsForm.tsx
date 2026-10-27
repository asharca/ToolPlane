"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Box, PackageCheck, Server, Users } from "lucide-react";
import { Button, ButtonLink } from "@/components/motion/button/base";
import { Input } from "@/components/motion/input";
import {
  ModelPicker,
  type ModelProviderOption,
} from "@/components/dashboard/models/ModelPicker";
import {
  AgentResourceSelect,
  type AgentResourceOption,
} from "./AgentResourceSelect";
import { AgentBuiltInTools } from "./AgentBuiltInTools";
import { AgentSystemPromptEditor } from "./AgentSystemPromptEditor";
import {
  prepareAgentRevisionAction,
  publishAgentRevisionAction,
  updateAgentAction,
} from "@/lib/agents/actions";
import {
  createAgentEnvironmentCredentialAction,
  listAgentEnvironmentCredentialsAction,
  revokeAgentEnvironmentCredentialAction,
} from "@/lib/agents/environment-credential-actions";
import type { AgentRevisionConfig } from "@/lib/agents/revision-types";
import { AGENT_STEP_BOUNDS } from "@/lib/agents/constants";

export type AgentSettingsSection =
  | "general"
  | "instructions"
  | "builtInTools"
  | "mcp"
  | "skills"
  | "piPackages"
  | "sandboxes"
  | "subAgents"
  | "advanced";
export type AgentPiPackageOption = {
  marketInstallId: string;
  name: string;
  currentReleaseId: string | null;
  currentVersion: number | null;
  currentAvailable: boolean;
  enabledReleaseId: string | null;
  enabledVersion: number | null;
  enabledAvailable: boolean;
};
type Props = {
  slug: string;
  workspaceId?: string;
  agentId: string;
  runtimeKind: string;
  name: string;
  description?: string;
  systemPrompt: string;
  disabledBuiltinTools?: string[];
  providerId: string | null;
  model: string | null;
  maxSteps: number;
  providers: Array<ModelProviderOption & { format: string }>;
  deployments: AgentResourceOption[];
  skills: AgentResourceOption[];
  piPackages?: AgentPiPackageOption[];
  defaultSandboxId?: string | null;
  sandboxes: AgentResourceOption[];
  subAgents: AgentResourceOption[];
  publishedRevision?: {
    id: string;
    version: number;
    config: AgentRevisionConfig;
  } | null;
  canManageCredentials?: boolean;
  className?: string;
  activeSection?: AgentSettingsSection;
  onSectionChange?: (section: AgentSettingsSection) => void;
  showNavigation?: boolean;
};
function selected(options: AgentResourceOption[]) {
  return new Set(
    options.filter((option) => option.checked).map((option) => option.id),
  );
}
export function AgentSettingsForm(props: Props) {
  const {
    slug,
    agentId,
    workspaceId = "",
    runtimeKind,
    providers,
    deployments,
    skills,
    sandboxes,
    subAgents,
    piPackages = [],
    publishedRevision = null,
    canManageCredentials = false,
  } = props;
  const t = useTranslations("console.agents");
  const r = useTranslations("console.agents.revisions");
  const router = useRouter();
  const [section, setSection] = useState<AgentSettingsSection>("general");
  const active = props.activeSection ?? section;
  const [name, setName] = useState(props.name);
  const [description, setDescription] = useState(props.description ?? "");
  const [prompt, setPrompt] = useState(props.systemPrompt);
  const [provider, setProvider] = useState(props.providerId ?? "");
  const [model, setModel] = useState(props.model ?? "");
  const [steps, setSteps] = useState(String(props.maxSteps));
  const [disabledTools, setDisabledTools] = useState(
    new Set(props.disabledBuiltinTools ?? []),
  );
  const [deploymentIds, setDeploymentIds] = useState(() =>
    selected(deployments),
  );
  const [skillIds, setSkillIds] = useState(() => selected(skills));
  const [sandboxIds, setSandboxIds] = useState(() => selected(sandboxes));
  const [subAgentIds, setSubAgentIds] = useState(() => selected(subAgents));
  const [packages, setPackages] = useState(() =>
    piPackages.flatMap((pkg) =>
      pkg.enabledReleaseId
        ? [
            {
              marketInstallId: pkg.marketInstallId,
              releaseId: pkg.enabledReleaseId,
            },
          ]
        : [],
    ),
  );
  const [environment, setEnvironment] = useState(() =>
    publishedRevision
      ? JSON.stringify(publishedRevision.config.environment, null, 2)
      : "",
  );
  const [review, setReview] = useState<{
    expectedRevisionId: string | null;
    config: AgentRevisionConfig;
  } | null>(null);
  const [reviewJson, setReviewJson] = useState("");
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [revision, setRevision] = useState(publishedRevision?.id ?? "");
  const [credentials, setCredentials] = useState<
    Array<{ id: string; name: string; revokedAt: Date | null }>
  >([]);
  const [credentialName, setCredentialName] = useState("");
  const [credentialValue, setCredentialValue] = useState("");
  function changed() {
    setDirty(true);
    setReview(null);
    setMessage("");
  }
  function identity() {
    const data = new FormData();
    data.set("workspace", slug);
    data.set("agentId", agentId);
    return data;
  }
  async function perform(operation: () => Promise<void>) {
    setPending(true);
    setError("");
    setMessage("");
    try {
      await operation();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setPending(false);
    }
  }
  async function saveDraft(data: FormData) {
    await perform(async () => {
      const result = await updateAgentAction({}, data);
      if (result.error) throw new Error(result.error);
      setDirty(false);
      setReview(null);
      setMessage(t("saved"));
      router.refresh();
    });
  }
  async function prepare() {
    await perform(async () => {
      if (dirty) throw new Error(r("prepareRequired"));
      const data = identity();
      if (environment.trim()) data.set("environment", environment);
      const prepared = await prepareAgentRevisionAction(data);
      setReview(prepared);
      setReviewJson(JSON.stringify(prepared.config, null, 2));
      setEnvironment(JSON.stringify(prepared.config.environment, null, 2));
    });
  }
  async function apply() {
    if (!review || dirty) return;
    await perform(async () => {
      const data = identity();
      data.set("expectedRevisionId", review.expectedRevisionId ?? "");
      data.set("config", reviewJson);
      const result = await publishAgentRevisionAction(data);
      setRevision(result.revisionId);
      setReview(null);
      setMessage(r("publishedSuccess"));
      router.refresh();
    });
  }
  async function loadCredentials() {
    const result = await listAgentEnvironmentCredentialsAction(identity());
    if (result.error) throw new Error(result.error);
    setCredentials(result.credentials ?? []);
  }
  const sections: Array<[AgentSettingsSection, string]> = [
    ["general", t("basic")],
    ["instructions", t("instructions")],
    ["builtInTools", t("builtInTools")],
    ["mcp", t("mcp")],
    ["skills", t("skills")],
    ["piPackages", t("piPackages")],
    ["sandboxes", r("environment")],
    ["subAgents", t("subAgents")],
    ["advanced", t("advanced")],
  ];
  const textareaClass =
    "w-full rounded-lg border border-border bg-background p-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
  if (runtimeKind !== "pi-sdk")
    return (
      <div className={props.className}>
        <p role="status">{r("legacy")}</p>
        <ButtonLink
          href={`/app/${encodeURIComponent(slug)}/agents?create=1`}
          variant="secondary"
        >
          {t("createPiSdkAgent")}
        </ButtonLink>
        {error ? <p role="alert">{error}</p> : null}
      </div>
    );
  return (
    <div className={props.className ?? "space-y-5 p-5"}>
      <header className="space-y-2">
        <h3 className="font-semibold">{r("draftTitle")}</h3>
        <p className="text-sm text-muted-foreground">{r("explanation")}</p>
        <p className="break-all text-xs">
          {r("published")}: {revision || r("unpublished")}
        </p>
      </header>
      {props.showNavigation !== false ? (
        <nav
          aria-label={t("configurationNavigation")}
          className="flex gap-2 overflow-x-auto"
        >
          {sections.map(([id, label]) => (
            <Button
              key={id}
              type="button"
              variant={active === id ? "secondary" : "ghost"}
              aria-current={active === id ? "page" : undefined}
              onClick={() => {
                setSection(id);
                props.onSectionChange?.(id);
              }}
            >
              {label}
            </Button>
          ))}
        </nav>
      ) : null}
      <form
        action={saveDraft}
        onChange={changed}
        data-unsaved-changes={dirty ? "true" : "false"}
        className="space-y-5"
      >
        <input type="hidden" name="workspace" value={slug} />
        <input type="hidden" name="agentId" value={agentId} />
        <input type="hidden" name="providerId" value={provider} />
        <input type="hidden" name="model" value={model} />
        <input
          type="hidden"
          name="piPackages"
          value={JSON.stringify(packages)}
        />
        <input
          type="hidden"
          name="defaultSandboxId"
          value={[...sandboxIds][0] ?? ""}
        />
        <fieldset disabled={pending} className="min-w-0 space-y-5">
          <section hidden={active !== "general"} className="space-y-4">
            <Input
              label={t("name")}
              name="name"
              required
              value={name}
              onChange={setName}
            />
            <label className="block space-y-2">
              <span>{t("description")}</span>
              <textarea
                name="description"
                value={description}
                maxLength={500}
                rows={3}
                onChange={(event) => setDescription(event.target.value)}
                className={textareaClass}
              />
            </label>
            <ModelPicker
              providers={providers}
              value={provider && model ? { providerId: provider, model } : null}
              onSelect={(selection) => {
                setProvider(selection.providerId);
                setModel(selection.model);
                changed();
              }}
              onConfigure={() =>
                window.location.assign(
                  `/app/${encodeURIComponent(slug)}/providers`,
                )
              }
              trigger={
                <Button
                  type="button"
                  variant="secondary"
                  aria-label={t("model")}
                >
                  {model || t("selectModel")}
                </Button>
              }
            />
          </section>
          <section hidden={active !== "instructions"}>
            <AgentSystemPromptEditor
              workspaceId={workspaceId}
              name={name}
              description={description}
              providerId={provider}
              model={model}
              value={prompt}
              onChange={(value) => {
                setPrompt(value);
                changed();
              }}
            />
          </section>
          <section hidden={active !== "builtInTools"}>
            <AgentBuiltInTools
              runtimeKind="pi-sdk"
              disabledTools={disabledTools}
              onDisabledToolsChange={(next) => {
                setDisabledTools(next);
                changed();
              }}
            />
          </section>
          <section hidden={active !== "mcp"}>
            <AgentResourceSelect
              icon={Server}
              label={t("mcp")}
              name="deploymentId"
              options={deployments}
              selectedIds={deploymentIds}
              onSelectionChange={(next) => {
                setDeploymentIds(next);
                changed();
              }}
            />
          </section>
          <section hidden={active !== "skills"}>
            <AgentResourceSelect
              icon={PackageCheck}
              label={t("skills")}
              name="installedSkillId"
              options={skills}
              selectedIds={skillIds}
              onSelectionChange={(next) => {
                setSkillIds(next);
                changed();
              }}
            />
          </section>
          <section hidden={active !== "piPackages"} className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {t("piPackageSecurity")} {t("piPackagesNewSession")}
            </p>
            {!piPackages.length ? <p>{t("piPackagesEmpty")}</p> : null}
            {piPackages.map((pkg) => {
              const selectedPackage = packages.find(
                (entry) => entry.marketInstallId === pkg.marketInstallId,
              );
              return (
                <div
                  key={pkg.marketInstallId}
                  className="space-y-2 rounded-lg border border-border p-3"
                >
                  <label className="flex items-center gap-3">
                    <input
                      type="checkbox"
                      checked={Boolean(selectedPackage)}
                      disabled={
                        !selectedPackage &&
                        (!pkg.currentAvailable || packages.length >= 16)
                      }
                      onChange={(event) => {
                        setPackages((current) =>
                          event.target.checked && pkg.currentReleaseId
                            ? [
                                ...current,
                                {
                                  marketInstallId: pkg.marketInstallId,
                                  releaseId: pkg.currentReleaseId,
                                },
                              ]
                            : current.filter(
                                (entry) =>
                                  entry.marketInstallId !== pkg.marketInstallId,
                              ),
                        );
                        changed();
                      }}
                    />
                    {pkg.name}
                  </label>
                  <p className="text-xs">
                    {t("piPackageWorkspaceVersion", {
                      version: pkg.currentVersion ?? "—",
                    })}
                  </p>
                  {selectedPackage ? (
                    <p className="text-xs">
                      {t("piPackageEnabledVersion", {
                        version:
                          selectedPackage.releaseId === pkg.currentReleaseId
                            ? (pkg.currentVersion ?? "—")
                            : (pkg.enabledVersion ?? "—"),
                      })}
                    </p>
                  ) : null}
                  {selectedPackage &&
                  pkg.currentAvailable &&
                  pkg.currentReleaseId &&
                  selectedPackage.releaseId !== pkg.currentReleaseId ? (
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => {
                        const releaseId = pkg.currentReleaseId;
                        if (releaseId)
                          setPackages((current) =>
                            current.map((entry) =>
                              entry.marketInstallId === pkg.marketInstallId
                                ? { ...entry, releaseId }
                                : entry,
                            ),
                          );
                        changed();
                      }}
                    >
                      {t("piPackageApplyWorkspaceVersion")}
                    </Button>
                  ) : null}
                  <ButtonLink
                    href={`/app/${encodeURIComponent(slug)}/market/installed/${encodeURIComponent(pkg.marketInstallId)}/clients#workspace-bindings`}
                    variant="ghost"
                  >
                    {t("piPackageMcpBindings")}
                  </ButtonLink>
                </div>
              );
            })}
            <ButtonLink
              href={`/app/${encodeURIComponent(slug)}/market/pi-packages`}
              variant="secondary"
            >
              {t("browsePiPackages")}
            </ButtonLink>
          </section>
          <section hidden={active !== "sandboxes"} className="space-y-4">
            <AgentResourceSelect
              icon={Box}
              label={t("sandboxes")}
              name="sandboxId"
              options={sandboxes.filter(
                (sandbox) =>
                  sandbox.kind === "docker" && sandbox.network !== "none",
              )}
              selectedIds={sandboxIds}
              selectionMode="single-required"
              onSelectionChange={(next) => {
                setSandboxIds(next);
                setEnvironment("");
                changed();
              }}
            />
          </section>
          <section hidden={active !== "subAgents"}>
            <AgentResourceSelect
              icon={Users}
              label={t("subAgents")}
              name="subAgentId"
              options={subAgents}
              selectedIds={subAgentIds}
              onSelectionChange={(next) => {
                setSubAgentIds(next);
                changed();
              }}
            />
          </section>
          <section hidden={active !== "advanced"}>
            <Input
              label={t("maxToolSteps")}
              name="maxSteps"
              type="number"
              min={AGENT_STEP_BOUNDS.min}
              max={AGENT_STEP_BOUNDS.max}
              value={steps}
              onChange={setSteps}
            />
          </section>
          <Button type="submit" variant="secondary">
            {pending ? t("saving") : r("saveDraft")}
          </Button>
        </fieldset>
      </form>
      {active === "sandboxes" ? (
        <section className="space-y-4">
          <label className="block space-y-2">
            <span className="font-medium">{r("environment")}</span>
            <span className="block text-xs text-muted-foreground">
              {r("environmentHelp")}
            </span>
            <textarea
              aria-label={r("environment")}
              rows={14}
              value={environment}
              onChange={(event) => {
                setEnvironment(event.target.value);
                setReview(null);
              }}
              className={`${textareaClass} font-mono`}
            />
          </label>
          <h4 className="font-medium">{r("credentials")}</h4>
          {canManageCredentials ? (
            <>
              <Button
                type="button"
                variant="secondary"
                disabled={pending}
                onClick={() => void perform(loadCredentials)}
              >
                {r("loadCredentials")}
              </Button>
              <Input
                label={r("credentialName")}
                value={credentialName}
                onChange={setCredentialName}
              />
              <Input
                label={r("credentialValue")}
                type="password"
                value={credentialValue}
                onChange={setCredentialValue}
              />
              <Button
                type="button"
                disabled={pending || !credentialName || !credentialValue}
                onClick={() =>
                  void perform(async () => {
                    const data = identity();
                    data.set("name", credentialName);
                    data.set("value", credentialValue);
                    const result =
                      await createAgentEnvironmentCredentialAction(data);
                    if (result.error) throw new Error(result.error);
                    setCredentialValue("");
                    await loadCredentials();
                  })
                }
              >
                {r("createCredential")}
              </Button>
              {credentials.length ? (
                credentials.map((credential) => (
                  <div
                    key={credential.id}
                    className="space-y-2 rounded-lg border border-border p-3"
                  >
                    <p>{credential.name}</p>
                    <code className="block break-all text-xs">
                      {JSON.stringify({
                        name: credential.name,
                        credentialId: credential.id,
                      })}
                    </code>
                    {credential.revokedAt ? (
                      <p>{String(credential.revokedAt)}</p>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        <Button
                          type="button"
                          variant="secondary"
                          disabled={pending || !environment.trim()}
                          onClick={() =>
                            void perform(async () => {
                              const definition = JSON.parse(
                                environment,
                              ) as AgentRevisionConfig["environment"];
                              definition.credentialReferences = [
                                ...definition.credentialReferences.filter(
                                  (reference) =>
                                    reference.name !== credential.name,
                                ),
                                {
                                  name: credential.name,
                                  credentialId: credential.id,
                                },
                              ];
                              setEnvironment(
                                JSON.stringify(definition, null, 2),
                              );
                              setReview(null);
                            })
                          }
                        >
                          {r("credentialRef")}
                        </Button>
                        <Button
                          type="button"
                          variant="secondary"
                          disabled={pending}
                          onClick={() =>
                            void perform(async () => {
                              const data = identity();
                              data.set("credentialId", credential.id);
                              const result =
                                await revokeAgentEnvironmentCredentialAction(
                                  data,
                                );
                              if ("error" in result)
                                throw new Error(result.error);
                              await loadCredentials();
                              setReview(null);
                            })
                          }
                        >
                          {r("revokeCredential")}
                        </Button>
                      </div>
                    )}
                  </div>
                ))
              ) : (
                <p className="text-sm text-muted-foreground">
                  {r("noCredentials")}
                </p>
              )}
            </>
          ) : (
            <p>{r("credentialOwner")}</p>
          )}
        </section>
      ) : null}
      <div className="flex flex-wrap gap-3">
        <Button
          type="button"
          disabled={pending || dirty}
          onClick={() => void prepare()}
        >
          {r("prepare")}
        </Button>
      </div>
      {review ? (
        <section
          aria-label={r("review")}
          className="space-y-3 rounded-lg border border-border p-4"
        >
          <h4 className="font-semibold">{r("review")}</h4>
          <p className="text-sm text-muted-foreground">{r("reviewHelp")}</p>
          <p className="break-all text-xs">
            {r("published")}: {review.expectedRevisionId ?? r("unpublished")}
          </p>
          {publishedRevision ? (
            <details>
              <summary>{r("published")}</summary>
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all text-xs">
                {JSON.stringify(publishedRevision.config, null, 2)}
              </pre>
            </details>
          ) : null}
          <textarea
            aria-label={r("review")}
            rows={22}
            value={reviewJson}
            onChange={(event) => setReviewJson(event.target.value)}
            className={`${textareaClass} font-mono`}
          />
          <div className="flex flex-wrap gap-3">
            <Button
              type="button"
              disabled={pending || dirty}
              onClick={() => void apply()}
            >
              {r("apply")}
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setReview(null)}
            >
              {r("discard")}
            </Button>
          </div>
        </section>
      ) : null}
      {error ? (
        <p role="alert" className="break-words text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {message ? (
        <p role="status" className="text-sm">
          {message}
        </p>
      ) : null}
    </div>
  );
}
