"use client";

import { FormCheckbox } from "@/components/ui/FormCheckbox";

import { Input } from "@/components/motion/input";

import {
  startTransition,
  useActionState,
  useCallback,
  useEffect,
  useRef,
  useState,
  useTransition,
} from "react";
import { Upload } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button, ButtonLink } from "@/components/motion/button";
import {
  CenterMorphModal,
  CenterMorphModalContent,
  CenterMorphModalTrigger,
} from "@/components/motion/center-morph-modal";
import {
  previewPiPackageSourceAction,
  publishPiPackageReleaseAction,
  publishAssembledPiPackageReleaseAction,
  publishAssistantReleaseAction,
  publishMcpReleaseAction,
  publishSkillReleaseAction,
} from "@/lib/market/actions";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import type { MarketActionState } from "@/lib/market/actions";

import type { PiPackageSourcePreviewState } from "@/lib/market/actions";
import { PiAssemblyResourceInputs } from "@/components/dashboard/market/PiCatalogForms";
const initialState: MarketActionState = {};

type PublishAction = (
  state: MarketActionState,
  formData: FormData,
) => Promise<MarketActionState>;

type ListingDefaults = {
  name: string;
  slug: string;
  summary: string | null;
  tags: string[];
  categoryIds: string[];
};

export type PiCompositionOptions = {
  packages?: Array<{ id: string; name: string }>;
  skills: Array<{ id: string; name: string; selected?: boolean }>;
  deployments: Array<{
    id: string;
    name: string;
    tools: string[];
    selected?: boolean;
  }>;
};

type CategoryOption = { id: string; name: string };
export type PiSourceOption = {
  id: string;
  name: string;
  kind: "catalog" | "npm" | "git";
  url: string;
};

type MarketPublishFormProps = {
  workspace: string;
  listing?: ListingDefaults;
  canPublish: boolean;
  categories: CategoryOption[];
  action: PublishAction;
  inline?: boolean;
} & (
  | {
      sourceField:
        | "deploymentId"
        | "installedSkillId"
        | "assistantId"
        | "toolkitId";
      resource: {
        id: string;
        name: string;
        slug: string;
        description: string | null;
      };
    }
  | {
      sourceField: "source";
      listingId?: string;
      visibility?: "private" | "public";
      sources?: PiSourceOption[];
    }
  | {
      sourceField: "composition";
      listingId?: string;
      visibility?: "private" | "public";
      options: PiCompositionOptions;
      resource?: {
        id: string;
        name: string;
        slug: string;
        description: string | null;
      };
    }
);

function MarketPublishForm(props: MarketPublishFormProps) {
  const {
    workspace,
    listing,
    canPublish,
    categories,
    sourceField,
    action: publishAction,
  } = props;
  const resource = "resource" in props ? props.resource : null;
  const t = useTranslations("console.market");
  const [piSourceType, setPiSourceType] = useState<"git" | "zip">("git");
  const [publicListing, setPublicListing] = useState(
    "visibility" in props && props.visibility === "public",
  );
  const [codeAcknowledged, setCodeAcknowledged] = useState(false);
  const [submittedPrivate, setSubmittedPrivate] = useState(false);
  const [submittedOwnerTrusted, setSubmittedOwnerTrusted] = useState(false);
  const [state, action, publishPending] = useActionState(
    publishAction,
    initialState,
  );
  const formRef = useRef<HTMLFormElement>(null);
  const [sourceId, setSourceId] = useState("");
  const [previewState, setPreviewState] =
    useState<PiPackageSourcePreviewState | null>(null);
  const [previewPending, startPreview] = useTransition();
  const previewRevision = useRef(0);
  const [filePage, setFilePage] = useState(0);
  const preview = previewState?.preview;
  const clearPreview = useCallback(() => {
    previewRevision.current += 1;
    setPreviewState(null);
    setFilePage(0);
  }, []);
  const inspectPiSource = () => {
    const form = formRef.current;
    if (!form || sourceField !== "source") return;
    const data = new FormData(form);
    data.set("sourceType", piSourceType);
    const revision = ++previewRevision.current;
    setPreviewState(null);
    setFilePage(0);
    startPreview(async () => {
      const result = await previewPiPackageSourceAction({}, data);
      if (revision !== previewRevision.current) return;
      setPreviewState(result);
    });
  };
  useEffect(() => {
    if (
      state.ok ||
      state.error === "source_changed" ||
      state.error === "source_preview_required"
    )
      clearPreview();
  }, [state, clearPreview]);
  const errorLabels: Record<string, string> = {
    not_authorized: t("publishErrorUnauthorized"),
    source_not_found: t("publishErrorMissing"),
    listing_conflict: t("publishErrorConflict"),
    action_failed: t("publishErrorGeneric"),
    capture_busy: t("piCaptureBusy"),
    capture_image_missing: t("piCaptureImageMissing"),
    package_capture_failed: t("piCaptureFailed"),
    pi_extensions_missing: t("piExtensionsMissing"),
    invalid_categories: t("piInvalidCategories"),
    invalid_manifest: t("piInvalidManifest"),
    pi_package_tools_unavailable: t("piComposeToolsUnavailable"),
    pi_package_name_invalid: t("piComposeInvalidIdentity"),
    pi_package_version_invalid: t("piComposeInvalidIdentity"),
    pi_package_invalid_selection: t("piComposeInvalidIdentity"),
    pi_package_source_unavailable: t("piComposeSourceUnavailable"),
    package_platform_mismatch: t("piPlatformMismatch"),
    pi_package_executable_confirmation_required: t(
      "piExecutableConfirmationRequired",
    ),
    source_preview_required: t("piPreviewRequired"),
    source_changed: t("piSourceChanged"),
    source_invalid: t("piCaptureFailed"),
    source_ref_missing: t("piCaptureFailed"),
    source_kind_mismatch: t("piCaptureFailed"),
    source_scope_mismatch: t("piCaptureFailed"),
    source_auth_failed: t("piCaptureFailed"),
    source_fetch_failed: t("piCaptureFailed"),
    source_network_blocked: t("piCaptureFailed"),
    source_response_invalid: t("piCaptureFailed"),
    source_response_too_large: t("piCaptureFailed"),
  };
  const filePageSize = 100;
  const filePageCount = Math.max(
    1,
    Math.ceil((preview?.files.length ?? 0) / filePageSize),
  );
  const visibleFiles =
    preview?.files.slice(
      filePage * filePageSize,
      (filePage + 1) * filePageSize,
    ) ?? [];

  if (!canPublish) {
    return (
      <span className="text-xs text-muted-foreground">
        {t("publishRequiresManager")}
      </span>
    );
  }

  const publishForm = state.ok ? (
    <section
      role="status"
      className="space-y-3 rounded-lg border border-border p-4"
    >
      <p>
        {t(
          submittedPrivate
            ? submittedOwnerTrusted
              ? "privatePackageSaved"
              : "privatePackageSavedPendingReview"
            : "releaseSubmitted",
        )}
      </p>
      <ButtonLink
        href={`/app/${encodeURIComponent(workspace)}/market/publish`}
        variant="secondary"
        size="sm"
      >
        {t("ownedPublications")}
      </ButtonLink>
    </section>
  ) : (
    <form
      ref={sourceField === "source" ? formRef : undefined}
      onSubmit={(event) => {
        // React form actions reset uncontrolled inputs even when the action
        // returns an error. Dispatch explicitly so user-selected files survive.
        event.preventDefault();
        if (publishPending) return;
        const data = new FormData(event.currentTarget);
        const privatePackage =
          (sourceField === "source" || sourceField === "composition") &&
          !publicListing;
        setSubmittedPrivate(privatePackage);
        setSubmittedOwnerTrusted(privatePackage && codeAcknowledged);
        startTransition(() => action(data));
      }}
      className={
        props.inline
          ? "grid gap-3 rounded-lg bg-muted/35 p-4 sm:grid-cols-2"
          : "mt-4 grid max-h-[75dvh] gap-3 overflow-y-auto rounded-lg bg-muted/35 p-4 sm:grid-cols-2"
      }
    >
      <input type="hidden" name="workspace" value={workspace} />
      {preview ? (
        <input type="hidden" name="sourceDigest" value={preview.sourceDigest} />
      ) : null}
      {props.sourceField === "source" || props.sourceField === "composition" ? (
        <>
          <input
            type="hidden"
            name="listingId"
            value={props.listingId ?? state.listingId ?? ""}
          />
          {props.sourceField === "source" ? (
            <div className="space-y-2 sm:col-span-2">
              <input type="hidden" name="sourceType" value={piSourceType} />
              <label className="block space-y-1 text-sm">
                <span>{t("piSourceType")}</span>
                <select
                  aria-label={t("piSourceType")}
                  disabled={previewPending}
                  value={piSourceType}
                  onChange={(event) => {
                    setPiSourceType(event.target.value as "git" | "zip");
                    setSourceId("");
                    clearPreview();
                  }}
                  className="w-full rounded-md border border-border bg-background px-3 py-2"
                >
                  <option value="git">{t("piSourceGit")}</option>
                  <option value="zip">{t("piSourceZip")}</option>
                </select>
              </label>
              {piSourceType === "zip" ? (
                <>
                  <label className="block space-y-1 text-sm">
                    <span>{t("zipArchive")}</span>
                    <input
                      name="archive"
                      type="file"
                      accept=".zip,application/zip"
                      required
                      disabled={previewPending}
                      onChange={clearPreview}
                      className="block w-full text-sm"
                    />
                  </label>
                  <p className="text-xs leading-5 text-muted-foreground">
                    {t("piZipPrivateTrust")}
                  </p>
                </>
              ) : (
                <>
                  <Input
                    key={piSourceType}
                    label={t("piSource")}
                    name="source"
                    required
                    maxLength={2048}
                    disabled={previewPending}
                    placeholder={
                      "https://github.com/org/repo.git#40-hex-commit"
                    }
                    onChange={clearPreview}
                  />
                  <label className="block space-y-1 text-sm">
                    <span>{t("piSourceWorkspaceSource")}</span>
                    <select
                      aria-label={t("piSourceWorkspaceSource")}
                      name="sourceId"
                      value={sourceId}
                      disabled={previewPending}
                      onChange={(event) => {
                        setSourceId(event.target.value);
                        clearPreview();
                      }}
                      className="w-full rounded-md border border-border bg-background px-3 py-2"
                    >
                      <option value="">{t("piSourceDirect")}</option>
                      {props.sources
                        ?.filter((source) => source.kind === piSourceType)
                        .map((source) => (
                          <option key={source.id} value={source.id}>
                            {source.name}
                          </option>
                        ))}
                    </select>
                  </label>
                </>
              )}
              {piSourceType !== "zip" ? (
                <p className="text-xs leading-5 text-muted-foreground">
                  {t("piSourceHelp")}
                </p>
              ) : null}
              <p className="text-xs leading-5 text-muted-foreground">
                {t("piExecutionWarning")}
              </p>
              <p className="text-xs leading-5 text-muted-foreground">
                {t("piHeadlessWarning")}
              </p>
            </div>
          ) : (
            <>
              <Input
                label={t("piComposePackageName")}
                name="packageName"
                required
                maxLength={214}
                placeholder="@team/package-name"
                defaultValue={resource?.slug}
              />
              <Input
                label={t("piComposePackageVersion")}
                name="packageVersion"
                required
                maxLength={100}
                placeholder="1.0.0"
                defaultValue={resource ? "1.0.0" : undefined}
              />
              <p className="text-xs text-muted-foreground sm:col-span-2">
                {t("piComposeIdentityHelp")}
              </p>
              <PiAssemblyResourceInputs packages={props.options.packages} />
              <fieldset className="space-y-2 sm:col-span-2">
                <legend className="text-sm font-medium">{t("skills")}</legend>
                {props.options.skills.length ? (
                  props.options.skills.map((skill) => (
                    <FormCheckbox
                      key={skill.id}
                      name="installedSkillIds"
                      value={skill.id}
                      label={skill.name}
                      defaultChecked={skill.selected}
                    />
                  ))
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {t("piComposeNoSkills")}
                  </p>
                )}
              </fieldset>
              <fieldset className="space-y-3 sm:col-span-2">
                <legend className="text-sm font-medium">
                  {t("piComposeMcpTools")}
                </legend>
                {props.options.deployments.map((deployment) => (
                  <div key={deployment.id} className="space-y-2">
                    <p className="text-xs font-medium">{deployment.name}</p>
                    {deployment.tools.length ? (
                      deployment.tools.map((tool) => (
                        <FormCheckbox
                          key={tool}
                          name="mcpTools"
                          value={JSON.stringify([deployment.id, tool])}
                          label={tool}
                          defaultChecked={deployment.selected}
                        />
                      ))
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        {t("piComposeNoTools")}
                      </p>
                    )}
                  </div>
                ))}
                <p className="text-xs text-muted-foreground">
                  {t("piComposeBindingHelp")}
                </p>
              </fieldset>
            </>
          )}
          <FormCheckbox
            name="confirmExecutableCode"
            value="on"
            checked={codeAcknowledged}
            onCheckedChange={setCodeAcknowledged}
            required={props.sourceField === "source" && piSourceType === "zip"}
            label={t("piExecutableConsent")}
          />
          <fieldset className="space-y-2 sm:col-span-2">
            <legend className="text-xs font-medium">{t("piVisibility")}</legend>
            <FormCheckbox
              name="visibility"
              value="public"
              checked={publicListing}
              onCheckedChange={setPublicListing}
              label={t("piVisibilityPublic")}
            />
            <p className="text-xs text-muted-foreground">
              {t("piVisibilityHelp")}
            </p>
          </fieldset>
          {sourceField === "source" ? (
            <section
              className="space-y-3 rounded-lg border border-border bg-background p-3 sm:col-span-2"
              aria-label={t("piPreviewHeading")}
            >
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={inspectPiSource}
                  disabled={previewPending}
                >
                  {previewPending
                    ? t("piPreviewWorking")
                    : t("piPreviewAction")}
                </Button>
                {previewPending ? (
                  <span role="status" className="text-xs text-muted-foreground">
                    {t("piPreviewWorking")}
                  </span>
                ) : null}
              </div>
              {previewState?.error ? (
                <p role="alert" className="text-sm text-destructive">
                  {errorLabels[previewState.error] ?? t("piCaptureFailed")}
                </p>
              ) : null}
              {preview ? (
                <div className="space-y-3">
                  <h3 className="text-sm font-semibold">
                    {t("piPreviewHeading")}
                  </h3>
                  <p className="break-all text-xs text-muted-foreground">
                    {preview.refPin}
                  </p>
                  <dl className="grid gap-x-4 gap-y-2 text-xs sm:grid-cols-2">
                    <div>
                      <dt className="font-medium">{t("piPreviewPackage")}</dt>
                      <dd>
                        {preview.name} {preview.version ?? ""}
                      </dd>
                    </div>
                    <div>
                      <dt className="font-medium">{t("piPreviewRuntime")}</dt>
                      <dd>
                        {preview.runtime.kind} · Pi {preview.runtime.piVersion}{" "}
                        · Node {preview.runtime.nodeMajor} ·{" "}
                        {preview.runtime.platform}/{preview.runtime.arch}
                      </dd>
                    </div>
                    <div>
                      <dt className="font-medium">{t("piPreviewSize")}</dt>
                      <dd>
                        {t("piPreviewSizeValue", {
                          count: preview.fileCount,
                          bytes: preview.totalBytes,
                        })}
                      </dd>
                    </div>
                    <div>
                      <dt className="font-medium">{t("piPreviewLicense")}</dt>
                      <dd>
                        {preview.metadata.license || t("piPreviewNotDeclared")}
                      </dd>
                    </div>
                  </dl>
                  {preview.metadata.description ? (
                    <p className="text-xs text-muted-foreground">
                      {preview.metadata.description}
                    </p>
                  ) : null}
                  {preview.metadata.keywords.length ? (
                    <p className="text-xs text-muted-foreground">
                      {t("piPreviewKeywords", {
                        keywords: preview.metadata.keywords.join(", "),
                      })}
                    </p>
                  ) : null}
                  <ul className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
                    <li>
                      {t("piPreviewExtensions", {
                        count: preview.resources.extensions.length,
                      })}
                    </li>
                    <li>
                      {t("piPreviewSkills", {
                        count: preview.resources.skills.length,
                      })}
                    </li>
                    <li>
                      {t("piPreviewPrompts", {
                        count: preview.resources.prompts.length,
                      })}
                    </li>
                    <li>
                      {t("piPreviewThemes", {
                        count: preview.resources.themes.length,
                      })}
                    </li>
                  </ul>
                  <div>
                    <h4 className="text-xs font-semibold">
                      {t("piPreviewMcpRequirements")}
                    </h4>
                    {preview.mcpRequirements.length ? (
                      <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
                        {preview.mcpRequirements.map((requirement) => (
                          <li key={requirement.key}>
                            {requirement.name}: {requirement.tools.join(", ")}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        {t("piPreviewNoMcpRequirements")}
                      </p>
                    )}
                  </div>
                  <details className="rounded-md border border-border p-2">
                    <summary className="cursor-pointer text-xs font-medium">
                      {t("piPreviewFiles", { count: preview.files.length })}
                    </summary>
                    <div className="mt-2 max-h-64 overflow-auto">
                      <table className="w-full text-left text-xs">
                        <thead>
                          <tr>
                            <th scope="col" className="pr-3">
                              {t("piPreviewFilePath")}
                            </th>
                            <th scope="col" className="pr-3">
                              {t("piPreviewFileType")}
                            </th>
                            <th scope="col">{t("piPreviewFileSize")}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {visibleFiles.map((file) => (
                            <tr
                              key={file.path}
                              className="border-t border-border/60"
                            >
                              <td className="max-w-64 break-all pr-3">
                                {file.path}
                              </td>
                              <td className="pr-3">{file.type}</td>
                              <td>{file.size}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {filePageCount > 1 ? (
                      <div className="mt-2 flex items-center justify-end gap-2">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={filePage === 0}
                          onClick={() => setFilePage((page) => page - 1)}
                        >
                          {t("piPreviewPrevious")}
                        </Button>
                        <span className="text-xs text-muted-foreground">
                          {t("piPreviewPage", {
                            current: filePage + 1,
                            total: filePageCount,
                          })}
                        </span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={filePage + 1 >= filePageCount}
                          onClick={() => setFilePage((page) => page + 1)}
                        >
                          {t("piPreviewNext")}
                        </Button>
                      </div>
                    ) : null}
                  </details>
                </div>
              ) : null}
            </section>
          ) : null}
        </>
      ) : (
        <input type="hidden" name={sourceField} value={props.resource.id} />
      )}
      <div className="text-xs font-medium text-foreground">
        <Input
          label={t("listingName")}
          name="name"
          required
          maxLength={240}
          defaultValue={listing?.name ?? resource?.name ?? ""}
          className="mt-1.5"
        />
      </div>
      <fieldset className="sm:col-span-2">
        <legend className="text-xs font-medium text-foreground">
          {t("filterByCategory")}
        </legend>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
          {categories.map((category) => (
            <FormCheckbox
              key={category.id}
              name="categoryIds"
              value={category.id}
              defaultChecked={listing?.categoryIds.includes(category.id)}
              label={category.name}
            />
          ))}
        </div>
      </fieldset>
      <div className="text-xs font-medium text-foreground">
        <Input
          label={t("listingSlug")}
          name="slug"
          required
          maxLength={100}
          defaultValue={listing?.slug ?? resource?.slug ?? ""}
          className="mt-1.5"
        />
      </div>
      <label className="text-xs font-medium text-foreground sm:col-span-2">
        {t("listingSummary")}
        <textarea
          name="summary"
          required
          maxLength={4000}
          rows={3}
          defaultValue={listing?.summary ?? resource?.description ?? ""}
          className="rounded-xl border border-border bg-background px-3 py-2 text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring mt-1.5 resize-y py-2"
        />
      </label>
      <div className="text-xs font-medium text-foreground">
        <Input
          label={t("listingTags")}
          name="tags"
          maxLength={400}
          defaultValue={listing?.tags.join(", ") ?? ""}
          placeholder={t("listingTagsPlaceholder")}
          className="mt-1.5"
        />
      </div>
      <div className="text-xs font-medium text-foreground">
        <Input
          label={t("releaseNotes")}
          name="releaseNotes"
          maxLength={10000}
          placeholder={t("releaseNotesPlaceholder")}
          className="mt-1.5"
        />
      </div>
      <div className="flex flex-wrap items-center justify-end gap-3 sm:col-span-2">
        {state.error ? (
          <p role="alert" className="text-sm text-destructive">
            {errorLabels[state.error] ?? t("publishErrorGeneric")}
          </p>
        ) : null}
        <Button
          type="submit"
          disabled={
            publishPending ||
            (sourceField === "source" && (!preview || previewPending))
          }
          aria-busy={publishPending || undefined}
          variant="primary"
          size="sm"
        >
          {publishPending
            ? t(sourceField === "source" ? "piCapturing" : "submittingRelease")
            : (sourceField === "source" || sourceField === "composition") &&
                !publicListing
              ? t("savePrivatePackage")
              : listing
                ? t("submitNewVersion")
                : t("submitForReview")}
        </Button>
      </div>
    </form>
  );
  return (
    <div className="sm:col-span-4">
      {props.inline ? (
        publishForm
      ) : (
        <CenterMorphModal>
          <CenterMorphModalTrigger>
            <Button type="button" variant="secondary" size="sm">
              <Upload className="size-3.5" />
              {sourceField === "composition"
                ? t(listing ? "piComposeNewVersion" : "piComposeTitle")
                : listing
                  ? t("publishNewVersion")
                  : t("publishToMarket")}
            </Button>
          </CenterMorphModalTrigger>
          <CenterMorphModalContent
            ariaLabel={listing ? t("publishNewVersion") : t("publishToMarket")}
          >
            {publishForm}
          </CenterMorphModalContent>
        </CenterMorphModal>
      )}
    </div>
  );
}

export function SkillPublishForm(props: {
  workspace: string;
  skill: { id: string; name: string; slug: string; description: string | null };
  listing?: ListingDefaults;
  canPublish: boolean;
  categories: CategoryOption[];
}) {
  return (
    <MarketPublishForm
      workspace={props.workspace}
      resource={props.skill}
      listing={props.listing}
      canPublish={props.canPublish}
      categories={props.categories}
      sourceField="installedSkillId"
      action={publishSkillReleaseAction}
    />
  );
}

export function AssistantPublishForm(props: {
  workspace: string;
  assistant: {
    id: string;
    name: string;
    slug: string;
    description: string | null;
  };
  listing?: ListingDefaults;
  canPublish: boolean;
  categories: CategoryOption[];
}) {
  return (
    <MarketPublishForm
      workspace={props.workspace}
      resource={props.assistant}
      listing={props.listing}
      canPublish={props.canPublish}
      categories={props.categories}
      sourceField="assistantId"
      action={publishAssistantReleaseAction}
    />
  );
}

export function McpPublishForm(props: {
  workspace: string;
  mcp: { id: string; name: string; slug: string; description: string | null };
  listing?: ListingDefaults;
  canPublish: boolean;
  categories: CategoryOption[];
  inline?: boolean;
}) {
  return (
    <MarketPublishForm
      workspace={props.workspace}
      resource={props.mcp}
      listing={props.listing}
      canPublish={props.canPublish}
      categories={props.categories}
      sourceField="deploymentId"
      action={publishMcpReleaseAction}
      inline={props.inline}
    />
  );
}

export function PiPackagePublishForm(props: {
  workspace: string;
  listing?: ListingDefaults;
  listingId?: string;
  canPublish: boolean;
  categories: CategoryOption[];
  visibility?: "private" | "public";
  sources?: PiSourceOption[];
  inline?: boolean;
}) {
  return (
    <MarketPublishForm
      {...props}
      sourceField="source"
      action={publishPiPackageReleaseAction}
    />
  );
}

export function PiPublicResubmissionForm(props: {
  workspace: string;
  releases: Array<{
    releaseId: string;
    version: number;
    checksum: string;
    listing: {
      id: string;
      slug: string;
      name: string;
      summary: string | null;
      tags: string[];
    };
  }>;
  categories: CategoryOption[];
}) {
  const t = useTranslations("console.market");
  const [state, action] = useActionState(
    publishPiPackageReleaseAction,
    initialState,
  );
  const [selectedId, setSelectedId] = useState(
    props.releases[0]?.releaseId ?? "",
  );
  const selected =
    props.releases.find((release) => release.releaseId === selectedId) ??
    props.releases[0];
  if (!selected) return null;
  if (state.ok)
    return (
      <section
        role="status"
        className="space-y-3 rounded-lg border border-border p-4"
      >
        <p>{t("releaseSubmitted")}</p>
        <ButtonLink
          href={`/app/${encodeURIComponent(props.workspace)}/market/publish`}
          variant="secondary"
          size="sm"
        >
          {t("ownedPublications")}
        </ButtonLink>
      </section>
    );
  return (
    <form
      action={action}
      className="space-y-4 rounded-xl border border-border p-4"
    >
      <input type="hidden" name="workspace" value={props.workspace} />
      <input type="hidden" name="sourceType" value="release" />
      <input type="hidden" name="visibility" value="public" />
      <label className="block space-y-1 text-sm">
        <span>{t("piPublicSourceRelease")}</span>
        <select
          name="targetReleaseId"
          value={selected.releaseId}
          onChange={(event) => setSelectedId(event.target.value)}
          className="w-full rounded-md border border-border bg-background px-3 py-2"
        >
          {props.releases.map((release) => (
            <option key={release.releaseId} value={release.releaseId}>
              {release.listing.name} · v{release.version}
            </option>
          ))}
        </select>
      </label>
      <p className="text-xs leading-5 text-muted-foreground">
        {t("piPublicResubmissionHelp")}
      </p>
      <div key={selected.releaseId} className="grid gap-3 sm:grid-cols-2">
        <Input
          label={t("listingName")}
          name="name"
          required
          maxLength={240}
          defaultValue={selected.listing.name}
        />
        <Input
          label={t("listingSlug")}
          name="slug"
          required
          maxLength={100}
          defaultValue={selected.listing.slug}
        />
        <label className="space-y-1 text-sm sm:col-span-2">
          {t("listingSummary")}
          <textarea
            name="summary"
            required
            maxLength={4000}
            rows={3}
            defaultValue={selected.listing.summary ?? ""}
            className="w-full resize-y rounded-xl border border-border bg-background px-3 py-2"
          />
        </label>
        <Input
          label={t("listingTags")}
          name="tags"
          maxLength={400}
          defaultValue={selected.listing.tags.join(", ")}
        />
        <fieldset className="space-y-2 sm:col-span-2">
          <legend className="text-sm font-medium">
            {t("filterByCategory")}
          </legend>
          <div className="flex flex-wrap gap-3">
            {props.categories.map((category) => (
              <FormCheckbox
                key={category.id}
                name="categoryIds"
                value={category.id}
                label={category.name}
              />
            ))}
          </div>
        </fieldset>
      </div>
      {state.error ? (
        <p role="alert" className="text-sm text-destructive">
          {t("publishErrorGeneric")}
        </p>
      ) : null}
      {state.ok ? (
        <p role="status" className="text-sm text-(--color-success)">
          {t("releaseSubmitted")}
        </p>
      ) : null}
      <SubmitButton
        pendingLabel={t("submittingRelease")}
        flash={false}
        variant="primary"
        size="sm"
      >
        {t("piSubmitPublicReview")}
      </SubmitButton>
    </form>
  );
}

export function PiPackageComposeForm(props: {
  workspace: string;
  listing?: ListingDefaults;
  listingId?: string;
  visibility?: "private" | "public";
  canPublish: boolean;
  categories: CategoryOption[];
  options: PiCompositionOptions;
  inline?: boolean;
  resource?: {
    id: string;
    name: string;
    slug: string;
    description: string | null;
  };
}) {
  return (
    <MarketPublishForm
      {...props}
      sourceField="composition"
      action={publishAssembledPiPackageReleaseAction}
    />
  );
}
