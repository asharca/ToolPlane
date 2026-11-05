"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { ChevronLeft, Upload } from "lucide-react";
import { Button, ButtonLink } from "@/components/motion/button/base";
import { Input } from "@/components/motion/input";
import { Checkbox } from "@/components/motion/checkbox";
import { CenterMorphModalClose } from "@/components/motion/center-morph-modal";
import {
  DialogBody,
  DialogField,
  DialogFooter,
  DialogHeader,
} from "@/components/dashboard/dialog";
import {
  ModelPicker,
  ModelPickerTrigger,
  type ModelProviderOption,
  type ModelSelection,
} from "@/components/dashboard/models/ModelPicker";
import { agentRuntimeSupportsProviderFormat } from "@/lib/agents/runtime-kind";
import {
  OMP_IMPORT_MAX_BYTES,
  OmpImportBundleSchema,
  OmpImportPreviewSchema,
  OmpImportRequestSchema,
  type OmpImportBundle,
  type OmpImportPreview,
  type OmpImportRequest,
} from "@/lib/agents/omp-import-contract";

type Resource = Pick<
  OmpImportPreview["resources"][number],
  "id" | "kind" | "name"
>;
type ImportError =
  | "fileInvalid"
  | "fileTooLarge"
  | "configInvalid"
  | "previewFailed"
  | "commitFailed"
  | "authorizationFailed"
  | "previewExpired"
  | "unsafeHref";

export function OmpImport({
  slug,
  providers,
  defaultModel,
  createOnly,
  onBack,
  onCancel,
}: {
  slug: string;
  providers: Array<ModelProviderOption & { format: string }>;
  defaultModel?: ModelSelection | null;
  createOnly: boolean;
  onBack: () => void;
  onCancel: () => void;
}) {
  const t = useTranslations("console.agents.ompImport");
  const agentsT = useTranslations("console.agents");
  const [bundle, setBundle] = useState<OmpImportBundle | null>(null);
  const runtimeKind = "pi-sdk";
  const [name, setName] = useState("");
  const [selection, setSelection] = useState<ModelSelection | null>(null);
  const [excludedIds, setExcludedIds] = useState<string[]>([]);
  const [configs, setConfigs] = useState<Record<string, string>>({});
  const [secrets, setSecrets] = useState<
    NonNullable<OmpImportRequest["mcpSecrets"]>
  >({});
  const [preview, setPreview] = useState<OmpImportPreview | null>(null);
  const [previewCurrent, setPreviewCurrent] = useState(false);
  const [approved, setApproved] = useState(false);
  const [inspectMcp, setInspectMcp] = useState(false);
  const [pending, setPending] = useState<"file" | "preview" | "commit" | null>(
    null,
  );
  const [error, setError] = useState<ImportError | null>(null);
  const [errorResource, setErrorResource] = useState("");
  const [errorDiagnostic, setErrorDiagnostic] = useState<string | null>(null);
  const busy = useRef(false);
  const alive = useRef(true);
  const previewAbort = useRef<AbortController | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [completed, setCompleted] = useState(false);
  const CancelContainer = createOnly ? CenterMorphModalClose : Fragment;
  const compatibleProviders = providers.filter((provider) =>
    agentRuntimeSupportsProviderFormat(runtimeKind, provider.format),
  );
  const selectedProvider = compatibleProviders.find(
    (provider) => provider.id === selection?.providerId,
  );
  const validModel = Boolean(
    selection && selectedProvider?.models.includes(selection.model),
  );
  const resources: Resource[] = bundle
    ? [
        { id: "settings", kind: "settings", name: t("settingsResource") },
        {
          id: "instructions",
          kind: "instructions",
          name: t("instructionsResource"),
        },
        ...bundle.skills.map((item) => ({
          id: item.id,
          kind: "skill" as const,
          name: item.name,
        })),
        ...bundle.plugins.map((item) => ({
          id: item.id,
          kind: "plugin" as const,
          name: item.plugin.name,
        })),
        ...bundle.mcpServers.map((item) => ({
          id: item.id,
          kind: "mcp" as const,
          name: item.name,
        })),
      ]
    : [];
  const resourceIds = new Set(resources.map((resource) => resource.id));
  const unavailableResourceIds = new Set<string>();
  for (const issue of bundle?.issues ?? []) {
    const id = issue.resourceId;
    if (!id || resourceIds.has(id)) continue;
    const kind = id.startsWith("plugin:")
      ? "plugin"
      : id.startsWith("skill:")
        ? "skill"
        : id.startsWith("mcp:")
          ? "mcp"
          : null;
    if (!kind) continue;
    resources.push({ id, kind, name: issue.path || id });
    unavailableResourceIds.add(id);
    resourceIds.add(id);
  }
  const visibleResources = preview ? preview.resources : resources;
  const issues = preview?.issues ?? bundle?.issues ?? [];
  const canPreview = Boolean(bundle && name.trim() && validModel && !pending);
  const canCommit =
    canPreview && previewCurrent && preview?.canImport && approved;

  useEffect(() => {
    alive.current = true;
    fileRef.current?.focus({ preventScroll: true });
    return () => {
      alive.current = false;
      previewAbort.current?.abort();
    };
  }, []);

  function invalidate(resetInspection = true) {
    setPreviewCurrent(false);
    setApproved(false);
    setError(null);
    setErrorDiagnostic(null);
    if (resetInspection) setInspectMcp(false);
  }

  // Preview and commit diagnostics never render raw request bodies or server errors.
  // In particular, a server error must not reflect an MCP credential into the page.
  async function responseError(
    response: Response,
    fallback: ImportError,
  ): Promise<ImportError> {
    try {
      const body: unknown = await response.json();
      if (
        alive.current &&
        body &&
        typeof body === "object" &&
        "error" in body &&
        typeof body.error === "string" &&
        /^OMP_IMPORT_[A-Z_]+$/.test(body.error) &&
        t.has(`diagnostics.${body.error}`)
      )
        setErrorDiagnostic(body.error);
    } catch {
      // Non-JSON failures use the localized recovery guidance without exposing a body.
    }
    if (
      response.status === 401 ||
      response.status === 403 ||
      response.status === 404
    )
      return "authorizationFailed";
    if (response.status === 409) return "previewExpired";
    return fallback;
  }

  function safeMessage(message: string) {
    let result = message;
    for (const values of Object.values(secrets)) {
      for (const value of Object.values(values)) {
        if (value) result = result.split(value).join("••••••••");
      }
    }
    return result;
  }

  function diagnosticMessage(message: string) {
    const key = `diagnostics.${message}`;
    return /^OMP_IMPORT_[A-Z_]+$/.test(message) && t.has(key)
      ? `${t(key)} (${message})`
      : safeMessage(message);
  }

  async function upload(file: File | undefined) {
    if (!file || busy.current) return;
    busy.current = true;
    setPending("file");
    invalidate();
    setBundle(null);
    setPreview(null);
    setConfigs({});
    setSecrets({});
    setExcludedIds([]);
    setName("");
    setSelection(null);
    try {
      if (file.size > OMP_IMPORT_MAX_BYTES) {
        setError("fileTooLarge");
        return;
      }
      const parsed = OmpImportBundleSchema.safeParse(
        JSON.parse(await file.text()),
      );
      if (!alive.current) return;
      if (!parsed.success) {
        setError("fileInvalid");
        return;
      }
      const next = parsed.data;
      setBundle(next);
      setName(next.name ?? "");
      setConfigs(
        Object.fromEntries(
          next.mcpServers.map((server) => [
            server.id,
            JSON.stringify(server.config, null, 2),
          ]),
        ),
      );
      const compatible = providers.filter((provider) =>
        agentRuntimeSupportsProviderFormat("pi-sdk", provider.format),
      );
      const sourceProvider = next.model?.provider;
      const sourceModel = next.model?.model;
      const matches = compatible.filter(
        (provider) =>
          sourceModel &&
          provider.models.includes(sourceModel) &&
          (!sourceProvider ||
            provider.id === sourceProvider ||
            provider.name.toLowerCase() === sourceProvider.toLowerCase()),
      );
      const preferred =
        defaultModel &&
        compatible.some(
          (provider) =>
            provider.id === defaultModel.providerId &&
            provider.models.includes(defaultModel.model),
        )
          ? defaultModel
          : null;
      setSelection(
        matches.length === 1 && sourceModel
          ? { providerId: matches[0].id, model: sourceModel }
          : preferred,
      );
    } catch {
      if (alive.current) setError("fileInvalid");
    } finally {
      busy.current = false;
      if (alive.current) setPending(null);
    }
  }

  function requestBody(): OmpImportRequest | null {
    if (!bundle || !selection) return null;
    const mcpConfigs: NonNullable<OmpImportRequest["mcpConfigs"]> = {};
    for (const server of bundle.mcpServers) {
      if (excludedIds.includes(server.id)) continue;
      try {
        const value: unknown = JSON.parse(configs[server.id] ?? "{}");
        if (!value || typeof value !== "object" || Array.isArray(value))
          throw new Error();
        mcpConfigs[server.id] = value as NonNullable<
          OmpImportRequest["mcpConfigs"]
        >[string];
      } catch {
        setErrorResource(server.name);
        setError("configInvalid");
        return null;
      }
    }
    const parsed = OmpImportRequestSchema.safeParse({
      bundle,
      runtimeKind,
      excludedIds,
      name: name.trim(),
      providerId: selection.providerId,
      model: selection.model,
      mcpConfigs,
      inspectMcp,
      mcpSecrets: Object.fromEntries(
        Object.entries(secrets).filter(([id]) => !excludedIds.includes(id)),
      ),
    });
    if (!parsed.success) {
      setError("fileInvalid");
      return null;
    }
    return parsed.data;
  }

  async function runPreview() {
    if (busy.current) return;
    invalidate(false);
    const body = requestBody();
    if (!body) return;
    busy.current = true;
    setPending("preview");
    const controller = new AbortController();
    previewAbort.current = controller;
    try {
      const response = await fetch(
        `/api/v1/workspaces/${encodeURIComponent(slug)}/agents/import/preview`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        },
      );
      if (!alive.current) return;
      if (!response.ok) {
        setError(await responseError(response, "previewFailed"));
        return;
      }
      const parsed = OmpImportPreviewSchema.safeParse(await response.json());
      if (!alive.current) return;
      if (!parsed.success) {
        setError("previewFailed");
        return;
      }
      setPreview(parsed.data);
      setPreviewCurrent(true);
    } catch {
      if (alive.current && !controller.signal.aborted)
        setError("previewFailed");
    } finally {
      busy.current = false;
      if (alive.current) setPending(null);
    }
  }

  async function commit() {
    if (busy.current || !canCommit || !preview) return;
    const body = requestBody();
    if (!body) return;
    busy.current = true;
    setPending("commit");
    setApproved(false);
    setPreviewCurrent(false);
    setError(null);
    setErrorDiagnostic(null);
    try {
      const response = await fetch(
        `/api/v1/workspaces/${encodeURIComponent(slug)}/agents/import`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...body,
            confirmed: true,
            previewChecksum: preview.checksum,
          }),
        },
      );
      if (!response.ok) {
        if (alive.current) {
          setError(await responseError(response, "commitFailed"));
          setApproved(false);
          setPreviewCurrent(false);
        }
        return;
      }
      const result: unknown = await response.json();
      if (
        !result ||
        typeof result !== "object" ||
        !("href" in result) ||
        typeof result.href !== "string" ||
        !("agentId" in result) ||
        typeof result.agentId !== "string"
      )
        throw new Error();
      const expected = `/app/${encodeURIComponent(slug)}/agents/${encodeURIComponent(result.agentId)}`;
      const destination = new URL(result.href, window.location.origin);
      if (
        destination.origin !== window.location.origin ||
        destination.pathname !== expected ||
        destination.search ||
        destination.hash ||
        destination.username ||
        destination.password
      ) {
        if (alive.current) setError("unsafeHref");
        return;
      }
      setCompleted(true);
      if (formRef.current) formRef.current.dataset.unsavedChanges = "false";
      if (alive.current) setSecrets({});
      // A full navigation also closes the route-driven creation modal and refreshes inventory.
      window.location.assign(destination.pathname);
    } catch {
      if (alive.current) {
        setError("commitFailed");
        setApproved(false);
        setPreviewCurrent(false);
      }
    } finally {
      busy.current = false;
      if (alive.current) setPending(null);
    }
  }

  return (
    <form
      id="agent-create-form"
      ref={formRef}
      data-unsaved-changes={
        !completed && (bundle || pending) ? "true" : "false"
      }
      onSubmit={(event) => {
        event.preventDefault();
        if (!previewCurrent) void runPreview();
      }}
      className={`flex min-h-0 flex-col overflow-hidden bg-background text-foreground ${createOnly ? "h-full" : "min-h-[38rem] max-h-[calc(100dvh-10rem)] rounded-3xl border border-border bg-card shadow-sm"}`}
      aria-busy={Boolean(pending)}
    >
      <DialogHeader title={t("title")} description={t("optionalHelp")} />
      <DialogBody className="overscroll-contain [scrollbar-width:thin]">
        <fieldset
          disabled={Boolean(pending)}
          className="min-w-0 space-y-5 disabled:opacity-70"
        >
          <section
            className="space-y-3 rounded-xl border border-border bg-muted/20 p-4"
            aria-labelledby="omp-export-title"
          >
            <h3 id="omp-export-title" className="text-sm font-semibold">
              {t("exportTitle")}
            </h3>
            <p className="text-xs leading-5 text-muted-foreground">
              {t("exportHelp")}
            </p>
            <pre className="overflow-x-auto rounded-lg bg-muted p-3 text-xs">
              <code>
                node scripts/export-omp-config.mjs --root ~/.omp/agent --output
                omp-import.json
              </code>
            </pre>
            <p className="text-xs leading-5 text-muted-foreground">
              {t("privacyHelp")}
            </p>
            <label
              htmlFor="omp-import-file"
              className="flex items-center gap-2 text-sm font-medium"
            >
              <Upload className="size-4" />
              {t("upload")}
            </label>
            <input
              ref={fileRef}
              id="omp-import-file"
              type="file"
              accept=".json,application/json"
              className="block w-full min-w-0 rounded-lg border border-border p-2 text-sm file:mr-3 file:rounded-md file:border-0 file:bg-muted file:px-3 file:py-1 file:text-foreground focus-visible:outline-ring"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                void upload(file);
              }}
            />
          </section>
          {bundle ? (
            <>
              <p className="text-xs text-muted-foreground">
                {t("sourceVersion", { version: bundle.ompVersion })}
              </p>
              <DialogField label={agentsT("name")} htmlFor="omp-import-name">
                <Input
                  id="omp-import-name"
                  required
                  maxLength={240}
                  value={name}
                  onChange={(value) => {
                    setName(value);
                    invalidate();
                  }}
                  className="w-full"
                />
              </DialogField>
              <DialogField
                label={t("targetRuntime")}
                description={t("migrateHelp")}
              >
                <p className="text-sm font-medium">{t("migrate")}</p>
              </DialogField>
              <DialogField
                label={agentsT("model")}
                description={t("modelHelp")}
              >
                <ModelPicker
                  className="flex w-full"
                  providers={compatibleProviders}
                  value={selection}
                  pending={Boolean(pending)}
                  onSelect={(value) => {
                    setSelection(value);
                    invalidate();
                  }}
                  trigger={
                    <ModelPickerTrigger
                      disabled={Boolean(pending)}
                      aria-label={`${agentsT("model")}: ${selection?.model ?? agentsT("selectModel")}`}
                      label={selection?.model ?? agentsT("selectModel")}
                      placeholder={!selection}
                      provider={selectedProvider?.name}
                      note={selectedProvider?.name}
                    />
                  }
                />
                {!compatibleProviders.some(
                  (provider) => provider.models.length > 0,
                ) ? (
                  <ButtonLink
                    href={`/app/${encodeURIComponent(slug)}/providers`}
                    variant="secondary"
                    className="mt-2"
                  >
                    {agentsT("addModelProvider")}
                  </ButtonLink>
                ) : null}
              </DialogField>
              <section
                className="space-y-3"
                aria-labelledby="omp-resources-title"
              >
                <h3 id="omp-resources-title" className="font-semibold">
                  {t("resourcesTitle")}
                </h3>
                <p className="text-xs leading-5 text-muted-foreground">
                  {t("exclusionsHelp")}
                </p>
                {visibleResources.map((resource, index) => {
                  const excluded = excludedIds.includes(resource.id);
                  const reviewed = preview?.resources.find(
                    (item) => item.id === resource.id,
                  );
                  const status = excluded
                    ? "excluded"
                    : previewCurrent
                      ? (reviewed?.status ?? "pending")
                      : unavailableResourceIds.has(resource.id)
                        ? "blocked"
                        : "pending";
                  const server = bundle.mcpServers.find(
                    (item) => item.id === resource.id,
                  );
                  const configSecretNames = [
                    ...(server ? (configs[server.id] ?? "") : "").matchAll(
                      /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
                    ),
                  ].map((match) => match[1]);
                  const requiredSecrets = [
                    ...new Set([
                      ...(server?.requiredSecrets ?? []),
                      ...(reviewed?.requiredSecrets ?? []),
                      ...configSecretNames,
                    ]),
                  ];
                  return (
                    <article
                      key={resource.id}
                      className="min-w-0 space-y-3 rounded-xl border border-border p-4"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <h4 className="min-w-0 break-words text-sm font-medium">
                          {safeMessage(resource.name)}
                        </h4>
                        <span
                          className={`rounded-full px-2 py-1 text-xs ${status === "blocked" ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground"}`}
                        >
                          {t(`status.${status}`)}
                        </span>
                      </div>
                      <p className="break-all text-xs text-muted-foreground">
                        {t(`kind.${resource.kind}`)} · {resource.id}
                      </p>
                      <Checkbox
                        checked={excluded}
                        label={t("excludeResource", {
                          name: safeMessage(resource.name),
                        })}
                        onCheckedChange={(checked) => {
                          setExcludedIds((current) =>
                            checked
                              ? [...current, resource.id]
                              : current.filter((id) => id !== resource.id),
                          );
                          invalidate();
                        }}
                      />
                      {reviewed?.messages.length ? (
                        <ul className="list-disc space-y-1 pl-4 text-xs leading-5 text-muted-foreground">
                          {[...new Set(reviewed.messages)].map((message) => (
                            <li key={message}>{diagnosticMessage(message)}</li>
                          ))}
                        </ul>
                      ) : null}
                      {(preview?.nativeRoles ?? [])
                        .filter((role) => role.resourceId === resource.id)
                        .map((role) => (
                          <div
                            key={role.path}
                            className="space-y-1 text-xs text-muted-foreground"
                          >
                            <p className="font-medium">{role.name}</p>
                            <p className="break-all">{role.path}</p>
                            <p>{t("nativeRoleIncompatible")}</p>
                          </div>
                        ))}
                      {server && !excluded ? (
                        <>
                          <DialogField
                            label={t("mcpConfig")}
                            htmlFor={`omp-config-${index}`}
                            description={t("mcpConfigHelp", {
                              placeholder: `\${ENV_NAME}`,
                            })}
                          >
                            <textarea
                              id={`omp-config-${index}`}
                              rows={6}
                              spellCheck={false}
                              value={configs[server.id] ?? "{}"}
                              onChange={(event) => {
                                setConfigs((current) => ({
                                  ...current,
                                  [server.id]: event.target.value,
                                }));
                                invalidate();
                              }}
                              className="w-full min-w-0 resize-y rounded-lg border border-border bg-muted/20 p-3 font-mono text-xs leading-5 focus-visible:outline-ring"
                            />
                          </DialogField>
                          {requiredSecrets.map((key, keyIndex) => (
                            <DialogField
                              key={key}
                              label={t("secret", { name: key })}
                              htmlFor={`omp-secret-${index}-${keyIndex}`}
                              description={t("secretHelp")}
                            >
                              <Input
                                id={`omp-secret-${index}-${keyIndex}`}
                                type="password"
                                autoComplete="new-password"
                                spellCheck={false}
                                value={secrets[server.id]?.[key] ?? ""}
                                onChange={(value) => {
                                  setSecrets((current) => ({
                                    ...current,
                                    [server.id]: {
                                      ...current[server.id],
                                      [key]: value,
                                    },
                                  }));
                                  invalidate();
                                }}
                                className="w-full"
                              />
                            </DialogField>
                          ))}
                          {previewCurrent && reviewed?.tools ? (
                            <div className="space-y-2 border-t border-border pt-3">
                              <h5 className="text-sm font-medium">
                                {t("toolsTitle")}
                              </h5>
                              <p className="text-xs leading-5 text-muted-foreground">
                                {t("toolsHelp")}
                              </p>
                              {reviewed.tools.length ? (
                                <ul className="space-y-2">
                                  {reviewed.tools.map((tool) => (
                                    <li
                                      key={tool.name}
                                      className="min-w-0 rounded-lg bg-muted/30 p-3 text-xs leading-5"
                                    >
                                      <p className="break-all font-mono font-medium">
                                        {safeMessage(tool.name)}
                                      </p>
                                      {tool.description ? (
                                        <p className="whitespace-pre-wrap break-words">
                                          {safeMessage(tool.description)}
                                        </p>
                                      ) : null}
                                      <details className="mt-1">
                                        <summary className="cursor-pointer">
                                          {t("toolSchema")}
                                        </summary>
                                        <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all font-mono">
                                          {safeMessage(
                                            JSON.stringify(
                                              tool.inputSchema ?? {},
                                              null,
                                              2,
                                            ),
                                          )}
                                        </pre>
                                      </details>
                                    </li>
                                  ))}
                                </ul>
                              ) : (
                                <p className="text-xs text-muted-foreground">
                                  {t("noTools")}
                                </p>
                              )}
                            </div>
                          ) : null}
                        </>
                      ) : null}
                    </article>
                  );
                })}
              </section>
              {issues.length ? (
                <section
                  className="space-y-2"
                  aria-labelledby="omp-issues-title"
                >
                  <h3 id="omp-issues-title" className="font-semibold">
                    {t("issuesTitle")}
                  </h3>
                  <ul className="space-y-2">
                    {issues.map((issue) => (
                      <li
                        key={issue.id}
                        className="break-words rounded-lg bg-muted/40 p-3 text-xs leading-5"
                      >
                        <span className="font-medium">
                          {issue.severity === "blocked"
                            ? t("status.blocked")
                            : t("warning")}
                          {issue.resourceId &&
                          excludedIds.includes(issue.resourceId)
                            ? ` · ${t("status.excluded")}`
                            : ""}
                        </span>
                        <p>{safeMessage(issue.message)}</p>
                        <p className="break-all text-muted-foreground">
                          {safeMessage(issue.path)} · {issue.code}
                        </p>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
              {bundle.mcpServers.some(
                (server) => !excludedIds.includes(server.id),
              ) ? (
                <div className="space-y-2 rounded-xl border border-border bg-muted/20 p-4">
                  <Checkbox
                    checked={inspectMcp}
                    label={t("inspectMcp")}
                    onCheckedChange={(checked) => {
                      invalidate();
                      setInspectMcp(checked);
                    }}
                  />
                  <p className="text-xs leading-5 text-muted-foreground">
                    {t("inspectMcpHelp")}
                  </p>
                </div>
              ) : null}
            </>
          ) : null}
        </fieldset>
        <div role="status" aria-live="polite" className="space-y-3 text-sm">
          {pending ? (
            <p>
              {t(
                pending === "file"
                  ? "reading"
                  : pending === "preview"
                    ? "previewing"
                    : "committing",
              )}
            </p>
          ) : null}
          {preview && !previewCurrent && !pending ? (
            <p className="text-muted-foreground">{t("previewStale")}</p>
          ) : null}
          {previewCurrent && preview ? (
            <p
              className={
                preview.canImport ? "text-foreground" : "text-destructive"
              }
            >
              {preview.canImport ? t("previewReady") : t("previewBlocked")}
            </p>
          ) : null}
        </div>
        {previewCurrent && preview?.canImport ? (
          <div className="rounded-xl border border-border bg-muted/20 p-4">
            <Checkbox
              checked={approved}
              disabled={Boolean(pending)}
              label={t("approve", {
                runtime: "Pi",
                count: excludedIds.length,
              })}
              onCheckedChange={setApproved}
            />
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              {t("approvalHelp")}
            </p>
          </div>
        ) : null}
        {error ? (
          <div
            role="alert"
            className="space-y-2 rounded-xl border border-destructive/20 bg-destructive/5 p-3 text-sm leading-6 text-destructive"
          >
            <p>
              {t(`errors.${error}`, {
                resource: safeMessage(errorResource),
                max: OMP_IMPORT_MAX_BYTES / 1024 / 1024,
              })}
            </p>
            {errorDiagnostic ? (
              <p>{diagnosticMessage(errorDiagnostic)}</p>
            ) : null}
          </div>
        ) : null}
      </DialogBody>
      <DialogFooter
        className="flex-wrap gap-2 px-4 sm:px-6 [&>div:last-child]:flex-wrap [&>div:last-child]:justify-end"
        start={
          <Button
            type="button"
            variant="ghost"
            disabled={Boolean(pending)}
            onClick={() => {
              if (!bundle || window.confirm(t("discard"))) onBack();
            }}
          >
            <ChevronLeft className="size-4" />
            {t("back")}
          </Button>
        }
        cancel={
          <CancelContainer>
            <Button
              type="button"
              variant="ghost"
              disabled={Boolean(pending)}
              onClick={
                createOnly
                  ? undefined
                  : () => {
                      if (!bundle || window.confirm(t("discard"))) onCancel();
                    }
              }
            >
              {agentsT("cancel")}
            </Button>
          </CancelContainer>
        }
      >
        {previewCurrent && preview?.canImport ? (
          <Button
            type="button"
            variant="primary"
            disabled={!canCommit}
            onClick={() => void commit()}
          >
            {t("commit")}
          </Button>
        ) : (
          <Button
            type="button"
            variant="primary"
            disabled={!canPreview}
            onClick={() => void runPreview()}
          >
            {t("preview")}
          </Button>
        )}
      </DialogFooter>
    </form>
  );
}
