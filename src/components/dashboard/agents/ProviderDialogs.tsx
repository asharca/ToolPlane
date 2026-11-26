"use client";

import {
  useActionState,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import {
  Cpu,
  ExternalLink,
  KeyRound,
  Link2,
  Loader2,
  LogIn,
  Pencil,
  Plus,
  Save,
  Search,
} from "lucide-react";
import { CopyButton } from "@/components/dashboard/CopyButton";
import { Button } from "@/components/motion/button/base";
import { Input } from "@/components/motion/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/motion/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/motion/tabs";
import { FormSelect } from "@/components/ui/FormSelect";
import {
  CenterMorphModal,
  CenterMorphModalTrigger,
  CenterMorphModalContent,
} from "@/components/motion/center-morph-modal";
import {
  DialogBody,
  DialogCancel,
  DialogField,
  DialogFooter,
  DialogHeader,
} from "@/components/dashboard/dialog";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import {
  createProviderAction,
  updateProviderAction,
} from "@/lib/agents/provider-actions";
import type { ActionState } from "@/lib/agents/action-state";
import type { ProviderOAuthSessionSnapshot } from "@/lib/agents/provider-oauth-types";
import { apiRequest } from "@/lib/client/api";
import type { ProviderRow } from "./ProvidersPanel";

export type ProviderAuthMode = "oauth" | "api_key";

export type ProviderOAuthMethodOption = {
  id: string;
  labelKey:
    | "oauthMethodBrowser"
    | "oauthMethodCopyCode"
    | "oauthMethodDeviceCode";
};

export type ProviderPreset = {
  format: string;
  name: string;
  baseUrl: string;
  authModes?: ProviderAuthMode[];
  oauthName?: string;
  oauthLoginLabel?: string;
  isSubscription?: boolean;
  oauthMethods?: ProviderOAuthMethodOption[];
  supportsEnterpriseDomain?: boolean;
};

const customProviderPresets: ProviderPreset[] = [
  { format: "openai", name: "OpenAI-compatible", baseUrl: "" },
  {
    format: "openai-responses",
    name: "OpenAI Responses-compatible",
    baseUrl: "",
  },
  { format: "anthropic", name: "Anthropic-compatible", baseUrl: "" },
];

export function providerEndpoint(
  provider: ProviderRow,
  presets: ProviderPreset[],
  fallback: string,
) {
  return (
    provider.baseUrl ||
    presets.find((preset) => preset.format === provider.format)?.baseUrl ||
    fallback
  );
}

export function ActionMessage({ state }: { state: ActionState }) {
  if (state.error) {
    return (
      <p className="mt-2 text-sm text-destructive" role="alert">
        {state.error}
      </p>
    );
  }
  if (state.warning) {
    return (
      <p className="mt-2 text-sm text-muted-foreground" role="alert">
        {state.warning}
      </p>
    );
  }
  return null;
}

export function ProviderDialog({
  open,
  onOpenChange,
  trigger,
  title,
  maxWidth = "max-w-xl",
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: ReactElement;
  title: string;
  /** Kept for caller compatibility; triggers render without tooltips. */
  labelledTrigger?: boolean;
  maxWidth?: "max-w-xl" | "max-w-2xl" | "max-w-3xl";
  children: ReactNode;
}) {
  const t = useTranslations("console.agents");
  const [rendered, setRendered] = useState(open);
  const openRef = useRef(open);
  if (open && !rendered) setRendered(true);
  useEffect(() => {
    openRef.current = open;
  }, [open]);
  useEffect(() => {
    if (open || !rendered) return;
    // Guarantee closed modal portals unmount even if an exit animation never reports completion.
    const timer = window.setTimeout(() => {
      if (!openRef.current) setRendered(false);
    }, 600);
    return () => window.clearTimeout(timer);
  }, [open, rendered]);
  const triggerElement = (
    <CenterMorphModalTrigger>{trigger}</CenterMorphModalTrigger>
  );

  return (
    <CenterMorphModal open={open} onOpenChange={onOpenChange}>
      {triggerElement}
      {rendered ? (
        <CenterMorphModalContent
          ariaLabel={title}
          closeButtonLabel={t("close")}
          onExitComplete={() => {
            if (!openRef.current) setRendered(false);
          }}
          className={`flex max-h-full w-full flex-col overflow-hidden ${maxWidth}`}
        >
          <DialogHeader title={title} className="border-b border-border" />
          {children}
        </CenterMorphModalContent>
      ) : null}
    </CenterMorphModal>
  );
}

export function providerFormatLabel(
  format: string,
  piProviderPresets: ProviderPreset[],
) {
  return (
    [...piProviderPresets, ...customProviderPresets].find(
      (preset) => preset.format === format,
    )?.name ?? format
  );
}

function providerFormatOptions(piProviderPresets: ProviderPreset[]) {
  return [...customProviderPresets, ...piProviderPresets].map((preset) => ({
    value: preset.format,
    label: preset.name,
  }));
}

function useProviderOAuth({
  slug,
  open,
  format,
  name,
  baseUrl,
  providerId,
  selectedPreset,
  onCompleted,
}: {
  slug: string;
  open: boolean;
  format: string;
  name: string;
  baseUrl: string;
  providerId?: string;
  selectedPreset?: ProviderPreset;
  onCompleted: (providerId?: string) => void;
}) {
  const common = useTranslations("common");
  const [oauthSession, setOAuthSession] =
    useState<ProviderOAuthSessionSnapshot | null>(null);
  const [oauthStarting, setOAuthStarting] = useState(false);
  const [oauthSubmitting, setOAuthSubmitting] = useState(false);
  const [oauthError, setOAuthError] = useState<string | null>(null);
  const [loginMethod, setLoginMethod] = useState<string>(
    () => selectedPreset?.oauthMethods?.[0]?.id ?? "",
  );
  const [enterpriseDomain, setEnterpriseDomain] = useState("");
  const [manualInput, setManualInput] = useState("");
  const openedInteractiveUrlRef = useRef<string | null>(null);
  const onCompletedRef = useRef(onCompleted);

  useEffect(() => {
    onCompletedRef.current = onCompleted;
  }, [onCompleted]);

  const handleSnapshot = useCallback(
    (snapshot: ProviderOAuthSessionSnapshot) => {
      setOAuthSession(snapshot);
      if (snapshot.status === "completed") {
        setOAuthError(null);
        onCompletedRef.current(snapshot.providerId);
        return;
      }
      if (snapshot.status === "failed") {
        setOAuthError(snapshot.error ?? null);
        return;
      }
      const interactiveUrl =
        snapshot.authUrl?.url ?? snapshot.deviceCode?.verificationUri;
      if (
        interactiveUrl &&
        openedInteractiveUrlRef.current !== interactiveUrl
      ) {
        openedInteractiveUrlRef.current = interactiveUrl;
        window.open(interactiveUrl, "_blank", "noopener,noreferrer");
      }
    },
    [],
  );

  function cancelOAuthSession(explicitSessionId?: string) {
    const idToCancel =
      explicitSessionId ??
      (oauthSession?.status === "waiting" ? oauthSession.sessionId : undefined);
    setOAuthSession(null);
    setOAuthStarting(false);
    setOAuthSubmitting(false);
    setOAuthError(null);
    setManualInput("");
    openedInteractiveUrlRef.current = null;
    if (idToCancel) {
      void apiRequest(
        `/api/v1/workspaces/${encodeURIComponent(slug)}/providers/oauth`,
        {
          method: "POST",
          json: { action: "cancel", sessionId: idToCancel },
        },
      );
    }
  }

  const waitingSessionId =
    open && oauthSession?.status === "waiting" ? oauthSession.sessionId : null;

  useEffect(() => {
    if (!waitingSessionId) return;
    let cancelled = false;
    const timer = window.setInterval(async () => {
      const result = await apiRequest<ProviderOAuthSessionSnapshot>(
        `/api/v1/workspaces/${encodeURIComponent(slug)}/providers/oauth`,
        {
          method: "POST",
          json: { action: "status", sessionId: waitingSessionId },
        },
      );
      if (cancelled) return;
      if (!result.ok) {
        if (result.status === 404) {
          setOAuthSession(null);
          setOAuthError(result.message ?? null);
        }
        return;
      }
      handleSnapshot(result.data);
    }, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [waitingSessionId, slug, handleSnapshot]);

  async function startOAuth() {
    const trimmedName = name.trim();
    if (!trimmedName || oauthStarting) return;
    setOAuthStarting(true);
    setOAuthError(null);
    setManualInput("");
    openedInteractiveUrlRef.current = null;
    const effectiveMethod =
      selectedPreset?.oauthMethods && selectedPreset.oauthMethods.length > 0
        ? loginMethod || selectedPreset.oauthMethods[0].id
        : undefined;
    const result = await apiRequest<ProviderOAuthSessionSnapshot>(
      `/api/v1/workspaces/${encodeURIComponent(slug)}/providers/oauth`,
      {
        method: "POST",
        json: {
          action: "start",
          format,
          name: trimmedName,
          ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
          ...(providerId ? { providerId } : {}),
          ...(effectiveMethod ? { loginMethod: effectiveMethod } : {}),
          ...(selectedPreset?.supportsEnterpriseDomain
            ? { enterpriseDomain: enterpriseDomain.trim() }
            : {}),
        },
      },
    );
    setOAuthStarting(false);
    if (!result.ok) {
      setOAuthError(result.message ?? common("operationFailed"));
      return;
    }
    handleSnapshot(result.data);
  }

  async function submitOAuthInput(value: string) {
    if (!oauthSession || oauthSubmitting) return;
    const trimmed = value.trim();
    if (!trimmed) return;
    setOAuthSubmitting(true);
    setOAuthError(null);
    const result = await apiRequest<ProviderOAuthSessionSnapshot>(
      `/api/v1/workspaces/${encodeURIComponent(slug)}/providers/oauth`,
      {
        method: "POST",
        json: {
          action: "input",
          sessionId: oauthSession.sessionId,
          value: trimmed,
        },
      },
    );
    setOAuthSubmitting(false);
    if (!result.ok) {
      setOAuthError(result.message ?? common("operationFailed"));
      return;
    }
    setManualInput("");
    handleSnapshot(result.data);
  }

  return {
    oauthSession,
    oauthStarting,
    oauthSubmitting,
    oauthError,
    setOAuthError,
    loginMethod,
    setLoginMethod,
    enterpriseDomain,
    setEnterpriseDomain,
    manualInput,
    setManualInput,
    startOAuth,
    submitOAuthInput,
    cancelOAuthSession,
  };
}

function OAuthSetupFields({
  fieldId,
  format,
  selectedPreset,
  loginMethod,
  onLoginMethodChange,
  enterpriseDomain,
  onEnterpriseDomainChange,
  baseUrl,
  onBaseUrlChange,
  oauthError,
}: {
  fieldId: string;
  format: string;
  selectedPreset?: ProviderPreset;
  loginMethod: string;
  onLoginMethodChange: (value: string) => void;
  enterpriseDomain: string;
  onEnterpriseDomainChange: (value: string) => void;
  baseUrl: string;
  onBaseUrlChange: (value: string) => void;
  oauthError: string | null;
}) {
  const t = useTranslations("console.agents");

  return (
    <>
      {(selectedPreset?.oauthMethods?.length ?? 0) > 1 ? (
        <DialogField label={t("oauthLoginMethod")}>
          <FormSelect
            value={loginMethod || selectedPreset?.oauthMethods?.[0]?.id || ""}
            label={t("oauthLoginMethod")}
            options={(selectedPreset?.oauthMethods ?? []).map((method) => ({
              value: method.id,
              label: t(method.labelKey),
            }))}
            onValueChange={onLoginMethodChange}
            className="w-full"
          />
        </DialogField>
      ) : null}
      {selectedPreset?.supportsEnterpriseDomain ? (
        <DialogField
          label={t("enterpriseDomain")}
          htmlFor={`${fieldId}-enterpriseDomain`}
          dirty={enterpriseDomain !== ""}
        >
          <Input
            id={`${fieldId}-enterpriseDomain`}
            leftIcon={<Link2 />}
            value={enterpriseDomain}
            onChange={onEnterpriseDomainChange}
            placeholder={t("enterpriseDomainPlaceholder")}
            className="w-full"
          />
        </DialogField>
      ) : null}
      {format === "pi:radius" ? (
        <DialogField
          label={t("baseUrl")}
          htmlFor={`${fieldId}-oauthBaseUrl`}
          dirty={baseUrl !== ""}
        >
          <Input
            id={`${fieldId}-oauthBaseUrl`}
            leftIcon={<Link2 />}
            value={baseUrl}
            onChange={onBaseUrlChange}
            placeholder={selectedPreset?.baseUrl || "https://radius.pi.dev/v1"}
            className="w-full"
          />
        </DialogField>
      ) : null}
      {oauthError ? (
        <p className="mt-2 text-sm text-destructive" role="alert">
          {oauthError}
        </p>
      ) : null}
    </>
  );
}

function isSafeHttpUrl(value: string) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

function OAuthWaitingView({
  fieldId,
  oauthSession,
  manualInput,
  onManualInputChange,
  oauthSubmitting,
  onSubmitInput,
  oauthError,
}: {
  fieldId: string;
  oauthSession: ProviderOAuthSessionSnapshot;
  manualInput: string;
  onManualInputChange: (value: string) => void;
  oauthSubmitting: boolean;
  onSubmitInput: (value: string) => void;
  oauthError: string | null;
}) {
  const t = useTranslations("console.agents");
  const authInstructions = oauthSession.authUrl?.instructions?.trim() || "";
  const infoMessage = oauthSession.info?.message?.trim() || "";
  const showInfoMessage = Boolean(
    infoMessage && infoMessage !== authInstructions,
  );
  const infoLinks = (oauthSession.info?.links ?? []).filter((link) =>
    isSafeHttpUrl(link.url),
  );

  return (
    <>
      {oauthSession.deviceCode ? (
        <div className="space-y-3 rounded-xl border border-border bg-muted/30 p-4">
          <div className="space-y-1">
            <p className="text-xs font-medium text-foreground">
              {t("oauthDeviceCodeLabel")}
            </p>
            <p className="text-xs text-muted-foreground">
              {t("oauthDeviceCodeHint")}
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-background px-3.5 py-2.5">
            <code className="select-all font-mono text-lg font-semibold tracking-wider text-foreground">
              {oauthSession.deviceCode.userCode}
            </code>
            <div className="flex flex-wrap items-center gap-2">
              <CopyButton
                text={oauthSession.deviceCode.userCode}
                label={t("oauthCopyCode")}
              />
              <Button
                type="button"
                variant="primary"
                size="sm"
                onClick={() =>
                  window.open(
                    oauthSession.deviceCode?.verificationUri,
                    "_blank",
                    "noopener,noreferrer",
                  )
                }
              >
                <ExternalLink aria-hidden="true" className="size-3.5" />
                {t("oauthOpenBrowser")}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {oauthSession.authUrl ? (
        <div className="space-y-3 rounded-xl border border-border bg-muted/30 p-4">
          <p className="whitespace-pre-line text-xs text-muted-foreground">
            {authInstructions || t("oauthBrowserHint")}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="primary"
              size="sm"
              onClick={() =>
                window.open(
                  oauthSession.authUrl?.url,
                  "_blank",
                  "noopener,noreferrer",
                )
              }
            >
              <ExternalLink aria-hidden="true" className="size-3.5" />
              {t("oauthOpenBrowser")}
            </Button>
            <CopyButton
              text={oauthSession.authUrl.url}
              label={t("oauthCopyLink")}
            />
          </div>
          <p className="truncate font-mono text-[11px] text-muted-foreground">
            {oauthSession.authUrl.url}
          </p>
        </div>
      ) : null}

      {showInfoMessage || infoLinks.length > 0 ? (
        <div className="space-y-1.5 rounded-xl border border-border/70 bg-muted/20 px-3.5 py-2.5 text-xs text-muted-foreground">
          {showInfoMessage ? (
            <p className="whitespace-pre-line">{infoMessage}</p>
          ) : null}
          {infoLinks.length > 0 ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              {infoLinks.map((link) => (
                <a
                  key={link.url}
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
                >
                  <span>{link.label || link.url}</span>
                  <ExternalLink
                    aria-hidden="true"
                    className="size-3 shrink-0"
                  />
                </a>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {oauthSession.prompt ? (
        oauthSession.prompt.type === "select" &&
        oauthSession.prompt.options?.length ? (
          <DialogField label={oauthSession.prompt.message}>
            <div className="flex flex-wrap gap-2">
              {oauthSession.prompt.options.map((option) => (
                <Button
                  key={option.id}
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={oauthSubmitting}
                  onClick={() => onSubmitInput(option.id)}
                >
                  {option.label}
                </Button>
              ))}
            </div>
          </DialogField>
        ) : (
          <DialogField
            label={
              oauthSession.prompt.type === "manual_code"
                ? t("oauthPasteCodeLabel")
                : oauthSession.prompt.message
            }
            htmlFor={`${fieldId}-oauthPrompt`}
          >
            <div className="flex items-center gap-2">
              <Input
                id={`${fieldId}-oauthPrompt`}
                type={
                  oauthSession.prompt.type === "secret" ? "password" : "text"
                }
                autoComplete="off"
                value={manualInput}
                onChange={onManualInputChange}
                placeholder={
                  oauthSession.prompt.placeholder ||
                  t("oauthPasteCodePlaceholder")
                }
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    manualInput.trim() &&
                    !oauthSubmitting
                  ) {
                    event.preventDefault();
                    onSubmitInput(manualInput);
                  }
                }}
                className="min-w-0 flex-1"
              />
              <Button
                type="button"
                variant="primary"
                size="md"
                disabled={oauthSubmitting || !manualInput.trim()}
                aria-busy={oauthSubmitting || undefined}
                onClick={() => onSubmitInput(manualInput)}
              >
                {oauthSubmitting ? (
                  <>
                    <Loader2
                      aria-hidden="true"
                      className="size-4 animate-spin"
                    />
                    {t("oauthSubmitting")}
                  </>
                ) : (
                  t("oauthSubmitCode")
                )}
              </Button>
            </div>
          </DialogField>
        )
      ) : null}

      <div
        role="status"
        aria-live="polite"
        className="flex items-center gap-2 text-xs text-muted-foreground"
      >
        <Loader2
          aria-hidden="true"
          className="size-3.5 shrink-0 animate-spin"
        />
        <span>{oauthSession.progress.at(-1) ?? t("oauthWaitingBrowser")}</span>
      </div>

      {oauthError ? (
        <p className="text-sm text-destructive" role="alert">
          {oauthError}
        </p>
      ) : null}
    </>
  );
}

export function AddProviderDialog({
  slug,
  piProviderPresets,
  onCreated,
  iconTrigger = false,
}: {
  slug: string;
  piProviderPresets: ProviderPreset[];
  onCreated: (providerId: string, options?: { skipRefresh?: boolean }) => void;
  /** Compact icon trigger for the provider list; the empty state keeps the labelled button. */
  iconTrigger?: boolean;
}) {
  const commonPresets = [
    "openai",
    "openai-codex",
    "anthropic",
    "github-copilot",
    "google",
    "deepseek",
    "openrouter",
    "kimi-coding",
    "xai",
  ].flatMap((id) =>
    piProviderPresets.filter((preset) => preset.format === `pi:${id}`),
  );
  const otherPresets = piProviderPresets
    .filter((preset) => !commonPresets.includes(preset))
    .sort((a, b) => a.name.localeCompare(b.name));
  const initialPreset = commonPresets[0] ?? customProviderPresets[0];
  const t = useTranslations("console.agents");
  const common = useTranslations("common");
  const [open, setOpen] = useState(false);
  const [savedAtWhenOpened, setSavedAtWhenOpened] = useState<
    number | undefined
  >();
  const processedProviderId = useRef<string | null>(null);
  const [format, setFormat] = useState(initialPreset.format);
  const [name, setName] = useState(initialPreset.name);
  const [baseUrl, setBaseUrl] = useState("");
  const [initialModels, setInitialModels] = useState("");
  const [query, setQuery] = useState("");
  const [authMode, setAuthMode] = useState<ProviderAuthMode>(() =>
    initialPreset.authModes?.includes("oauth") ? "oauth" : "api_key",
  );
  const selectedPreset = [...piProviderPresets, ...customProviderPresets].find(
    (preset) => preset.format === format,
  );
  const isCustomProvider = !format.startsWith("pi:");
  const supportsOAuth = Boolean(
    !isCustomProvider && selectedPreset?.authModes?.includes("oauth"),
  );
  const supportsApiKey =
    isCustomProvider ||
    !selectedPreset?.authModes ||
    selectedPreset.authModes.includes("api_key");
  const effectiveAuthMode: ProviderAuthMode =
    supportsOAuth && (!supportsApiKey || authMode === "oauth")
      ? "oauth"
      : "api_key";

  const {
    oauthSession,
    oauthStarting,
    oauthSubmitting,
    oauthError,
    loginMethod,
    setLoginMethod,
    enterpriseDomain,
    setEnterpriseDomain,
    manualInput,
    setManualInput,
    startOAuth,
    submitOAuthInput,
    cancelOAuthSession,
  } = useProviderOAuth({
    slug,
    open,
    format,
    name,
    baseUrl,
    selectedPreset,
    onCompleted: (createdProviderId) => {
      if (
        createdProviderId &&
        processedProviderId.current !== createdProviderId
      ) {
        processedProviderId.current = createdProviderId;
        onCreated(createdProviderId, { skipRefresh: true });
      }
      setOpen(false);
    },
  });

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const presetGroups = [
    { label: t("compatibleProviders"), presets: customProviderPresets },
    { label: t("commonProviders"), presets: commonPresets },
    { label: t("otherProviders"), presets: otherPresets },
  ]
    .map((group) => ({
      ...group,
      presets: normalizedQuery
        ? group.presets.filter((preset) =>
            [
              group.label,
              preset.name,
              preset.format,
              preset.baseUrl,
              preset.oauthName ?? "",
              preset.oauthLoginLabel ?? "",
              preset.authModes?.includes("oauth")
                ? `oauth ${t("oauthBadge")} ${t("browserSignIn")}`
                : "",
            ].some((value) =>
              value.toLocaleLowerCase().includes(normalizedQuery),
            ),
          )
        : group.presets,
    }))
    .filter((group) => group.presets.length > 0);
  const [state, formAction] = useActionState<ActionState, FormData>(
    createProviderAction,
    {},
  );
  const [apiKey, setApiKey] = useState("");
  // Secret input is cleared after every action result; it must not survive a failed or successful submission.
  useEffect(() => {
    void state; // Every result, including failure, clears the secret.
    setApiKey("");
  }, [state]);
  const hasInitialModels =
    isCustomProvider &&
    initialModels
      .split(/[\n,，]+/)
      .some((id) => id.trim().length > 0 && id.trim().length <= 200);
  useEffect(() => {
    if (!state.providerId || processedProviderId.current === state.providerId)
      return;
    processedProviderId.current = state.providerId;
    onCreated(state.providerId, { skipRefresh: hasInitialModels });
  }, [state.providerId, onCreated, hasInitialModels]);

  function selectPreset(preset: ProviderPreset) {
    if (oauthSession?.status === "waiting") {
      cancelOAuthSession(oauthSession.sessionId);
    } else {
      cancelOAuthSession();
    }
    const previousIsCustom = !format.startsWith("pi:");
    const nextIsCustom = !preset.format.startsWith("pi:");
    // Keep a name the user typed; replace only the untouched preset name.
    if (!name.trim() || name === selectedPreset?.name) setName(preset.name);
    setFormat(preset.format);
    if (!previousIsCustom || !nextIsCustom) {
      setBaseUrl("");
    }
    setAuthMode(preset.authModes?.includes("oauth") ? "oauth" : "api_key");
    setLoginMethod(preset.oauthMethods?.[0]?.id ?? "");
    setEnterpriseDomain("");
  }

  const fieldId = useId();
  const defaultPresetName = selectedPreset?.name ?? initialPreset.name;
  const isNameDirty = name !== defaultPresetName;
  const isWaitingOAuth =
    effectiveAuthMode === "oauth" && oauthSession?.status === "waiting";
  return (
    <ProviderDialog
      open={open && (!state.savedAt || state.savedAt === savedAtWhenOpened)}
      onOpenChange={(next) => {
        if (next) {
          // A provider was created since the last opening: start a fresh form.
          if (state.savedAt && state.savedAt !== savedAtWhenOpened) {
            setFormat(initialPreset.format);
            setName(initialPreset.name);
            setBaseUrl("");
            setInitialModels("");
            setQuery("");
            setAuthMode(
              initialPreset.authModes?.includes("oauth") ? "oauth" : "api_key",
            );
            setLoginMethod(initialPreset.oauthMethods?.[0]?.id ?? "");
            setEnterpriseDomain("");
          }
          setSavedAtWhenOpened(state.savedAt);
        } else {
          setApiKey("");
          cancelOAuthSession();
        }
        setOpen(next);
      }}
      title={t("addModelProvider")}
      maxWidth="max-w-3xl"
      labelledTrigger={!iconTrigger}
      trigger={
        iconTrigger ? (
          <Button
            variant="secondary"
            size="icon"
            type="button"
            aria-label={t("addModelProvider")}
          >
            <Plus aria-hidden="true" className="size-4" />
          </Button>
        ) : (
          <Button variant="primary" size="md" type="button">
            <Plus aria-hidden="true" className="size-4" />
            {t("addProvider")}
          </Button>
        )
      }
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden md:h-[30rem] md:flex-initial md:flex-row">
        <div className="flex min-h-0 max-h-56 shrink-0 flex-col border-b border-border md:max-h-none md:w-56 md:border-b-0 md:border-r">
          <div className="p-3 pb-1">
            <Input
              leftIcon={<Search />}
              aria-label={`${common("search")} ${t("format")}`}
              placeholder={common("search")}
              value={query}
              onChange={setQuery}
              className="w-full"
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-3">
            {presetGroups.length > 0 ? (
              presetGroups.map((group) => (
                <fieldset
                  key={group.label}
                  className="m-0 min-w-0 border-0 p-0"
                >
                  <legend className="px-3 pb-1 pt-3 text-xs font-medium text-muted-foreground">
                    {group.label}
                  </legend>
                  <div className="space-y-1">
                    {group.presets.map((preset) => {
                      const selected = preset.format === format;
                      return (
                        <Button
                          key={preset.format}
                          type="button"
                          aria-pressed={selected}
                          onClick={() => selectPreset(preset)}
                          variant="ghost"
                          size="md"
                          className={`h-9 w-full justify-start gap-2 rounded-lg px-3 text-left text-sm ${selected ? "bg-muted font-medium text-foreground" : "font-normal"}`}
                        >
                          <span className="min-w-0 flex-1 truncate">
                            {preset.name}
                          </span>
                          {preset.authModes?.includes("oauth") ? (
                            <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                              {t("oauthBadge")}
                            </span>
                          ) : null}
                        </Button>
                      );
                    })}
                  </div>
                </fieldset>
              ))
            ) : (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                {common("noResults")}
              </p>
            )}
          </div>
        </div>

        {effectiveAuthMode === "oauth" ? (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <DialogBody>
              {supportsOAuth && supportsApiKey && !isWaitingOAuth ? (
                <DialogField label={t("authMethod")} layout="row">
                  <Tabs
                    variant="segment"
                    value={effectiveAuthMode}
                    onValueChange={(value) => {
                      const nextMode = value as ProviderAuthMode;
                      if (nextMode !== "oauth") cancelOAuthSession();
                      setAuthMode(nextMode);
                    }}
                  >
                    <TabsList
                      aria-label={t("authMethod")}
                      className="bg-muted/60"
                    >
                      <TabsTrigger value="oauth" className="px-3 py-1 text-xs">
                        {t("browserSignIn")}
                      </TabsTrigger>
                      <TabsTrigger
                        value="api_key"
                        className="px-3 py-1 text-xs"
                      >
                        {t("apiKeyAuth")}
                      </TabsTrigger>
                    </TabsList>
                  </Tabs>
                </DialogField>
              ) : null}

              {isWaitingOAuth && oauthSession ? (
                <OAuthWaitingView
                  fieldId={fieldId}
                  oauthSession={oauthSession}
                  manualInput={manualInput}
                  onManualInputChange={setManualInput}
                  oauthSubmitting={oauthSubmitting}
                  onSubmitInput={(value) => void submitOAuthInput(value)}
                  oauthError={oauthError}
                />
              ) : (
                <>
                  <DialogField
                    label={t("name")}
                    htmlFor={`${fieldId}-name`}
                    dirty={isNameDirty}
                  >
                    <Input
                      id={`${fieldId}-name`}
                      leftIcon={<Cpu />}
                      name="name"
                      required
                      value={name}
                      onChange={setName}
                      onKeyDown={(event) => {
                        if (
                          event.key === "Enter" &&
                          name.trim() &&
                          !oauthStarting
                        ) {
                          event.preventDefault();
                          void startOAuth();
                        }
                      }}
                      className="w-full"
                    />
                  </DialogField>
                  <OAuthSetupFields
                    fieldId={fieldId}
                    format={format}
                    selectedPreset={selectedPreset}
                    loginMethod={loginMethod}
                    onLoginMethodChange={setLoginMethod}
                    enterpriseDomain={enterpriseDomain}
                    onEnterpriseDomainChange={setEnterpriseDomain}
                    baseUrl={baseUrl}
                    onBaseUrlChange={setBaseUrl}
                    oauthError={oauthError ?? oauthSession?.error ?? null}
                  />
                </>
              )}
            </DialogBody>
            {isWaitingOAuth && oauthSession ? (
              <DialogFooter
                cancel={
                  <Button
                    type="button"
                    variant="ghost"
                    size="md"
                    onClick={() => cancelOAuthSession(oauthSession.sessionId)}
                  >
                    {t("oauthCancel")}
                  </Button>
                }
              />
            ) : (
              <DialogFooter cancel={<DialogCancel />}>
                <Button
                  type="button"
                  variant="primary"
                  size="md"
                  disabled={oauthStarting || !name.trim()}
                  aria-busy={oauthStarting || undefined}
                  onClick={() => void startOAuth()}
                >
                  {oauthStarting ? (
                    <>
                      <Loader2
                        aria-hidden="true"
                        className="size-4 animate-spin"
                      />
                      {t("oauthStarting")}
                    </>
                  ) : (
                    <>
                      <LogIn aria-hidden="true" className="size-4" />
                      {t("oauthStartSignIn")}
                    </>
                  )}
                </Button>
              </DialogFooter>
            )}
          </div>
        ) : (
          <form
            action={formAction}
            className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
          >
            <input type="hidden" name="workspace" value={slug} />
            <input type="hidden" name="format" value={format} />
            <DialogBody>
              {supportsOAuth && supportsApiKey ? (
                <DialogField label={t("authMethod")} layout="row">
                  <Tabs
                    variant="segment"
                    value={effectiveAuthMode}
                    onValueChange={(value) =>
                      setAuthMode(value as ProviderAuthMode)
                    }
                  >
                    <TabsList
                      aria-label={t("authMethod")}
                      className="bg-muted/60"
                    >
                      <TabsTrigger value="oauth" className="px-3 py-1 text-xs">
                        {t("browserSignIn")}
                      </TabsTrigger>
                      <TabsTrigger
                        value="api_key"
                        className="px-3 py-1 text-xs"
                      >
                        {t("apiKeyAuth")}
                      </TabsTrigger>
                    </TabsList>
                  </Tabs>
                </DialogField>
              ) : null}
              <DialogField
                label={t("name")}
                htmlFor={`${fieldId}-name`}
                dirty={isNameDirty}
              >
                <Input
                  id={`${fieldId}-name`}
                  leftIcon={<Cpu />}
                  name="name"
                  required
                  value={name}
                  onChange={setName}
                  className="w-full"
                />
              </DialogField>
              {isCustomProvider ? (
                <DialogField
                  label={t("protocolFormat")}
                  htmlFor={`${fieldId}-protocol`}
                >
                  <Select
                    value={format}
                    onValueChange={(value) => {
                      const nextPreset = customProviderPresets.find(
                        (preset) => preset.format === value,
                      );
                      if (nextPreset) selectPreset(nextPreset);
                    }}
                    className="w-full"
                  >
                    <SelectTrigger
                      id={`${fieldId}-protocol`}
                      aria-label={t("protocolFormat")}
                    >
                      <SelectValue placeholder={t("protocolFormat")}>
                        {selectedPreset?.name}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {customProviderPresets.map((preset) => (
                        <SelectItem
                          key={preset.format}
                          value={preset.format}
                          textValue={preset.name}
                        >
                          {preset.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </DialogField>
              ) : null}
              {/* The placeholder shows the endpoint used when this stays blank. */}
              <DialogField
                label={t("baseUrl")}
                htmlFor={`${fieldId}-baseUrl`}
                dirty={baseUrl !== ""}
              >
                <Input
                  id={`${fieldId}-baseUrl`}
                  leftIcon={<Link2 />}
                  name="baseUrl"
                  required={isCustomProvider}
                  placeholder={
                    isCustomProvider
                      ? "https://api.example.com/v1"
                      : selectedPreset?.baseUrl
                  }
                  value={baseUrl}
                  onChange={setBaseUrl}
                  className="w-full"
                />
              </DialogField>
              <DialogField
                label={t("apiKey")}
                htmlFor={`${fieldId}-apiKey`}
                dirty={apiKey !== ""}
              >
                <Input
                  id={`${fieldId}-apiKey`}
                  leftIcon={<KeyRound />}
                  name="apiKey"
                  type="password"
                  autoComplete="off"
                  required
                  value={apiKey}
                  onChange={setApiKey}
                  className="w-full"
                />
              </DialogField>
              {isCustomProvider ? (
                <DialogField
                  label={t("initialModels")}
                  htmlFor={`${fieldId}-initialModels`}
                  dirty={initialModels !== ""}
                >
                  <Input
                    id={`${fieldId}-initialModels`}
                    name="initialModels"
                    placeholder={t("initialModelsPlaceholder")}
                    value={initialModels}
                    onChange={setInitialModels}
                    className="w-full"
                  />
                </DialogField>
              ) : null}
              <ActionMessage state={state} />
            </DialogBody>
            <DialogFooter cancel={<DialogCancel />}>
              <SubmitButton
                error={state.error}
                pendingLabel={t("adding")}
                savedLabel={t("added")}
                variant="primary"
                size="md"
              >
                <Plus aria-hidden="true" className="size-4" />
                {t("add")}
              </SubmitButton>
            </DialogFooter>
          </form>
        )}
      </div>
    </ProviderDialog>
  );
}

export function EditProviderDialog({
  slug,
  provider,
  piProviderPresets,
  onUpdated,
}: {
  slug: string;
  provider: ProviderRow;
  piProviderPresets: ProviderPreset[];
  onUpdated?: () => void;
}) {
  const t = useTranslations("console.agents");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [savedAtWhenOpened, setSavedAtWhenOpened] = useState<
    number | undefined
  >();
  const [format, setFormat] = useState(provider.format);
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl);
  const [name, setName] = useState(provider.name);
  const fieldId = useId();
  const selectedPreset = piProviderPresets.find(
    (preset) => preset.format === format,
  );
  const isCustomProvider = !format.startsWith("pi:");
  const supportsOAuth = Boolean(
    !isCustomProvider && selectedPreset?.authModes?.includes("oauth"),
  );
  const supportsApiKey =
    isCustomProvider ||
    !selectedPreset?.authModes ||
    selectedPreset.authModes.includes("api_key");
  const [authMode, setAuthMode] = useState<ProviderAuthMode>(() =>
    provider.authType === "oauth" || !supportsApiKey ? "oauth" : "api_key",
  );
  const effectiveAuthMode: ProviderAuthMode =
    supportsOAuth && (!supportsApiKey || authMode === "oauth")
      ? "oauth"
      : "api_key";

  const {
    oauthSession,
    oauthStarting,
    oauthSubmitting,
    oauthError,
    loginMethod,
    setLoginMethod,
    enterpriseDomain,
    setEnterpriseDomain,
    manualInput,
    setManualInput,
    startOAuth,
    submitOAuthInput,
    cancelOAuthSession,
  } = useProviderOAuth({
    slug,
    open,
    format,
    name,
    baseUrl,
    providerId: provider.id,
    selectedPreset,
    onCompleted: () => {
      setOpen(false);
      router.refresh();
      onUpdated?.();
    },
  });

  const [updateState, updateAction] = useActionState<ActionState, FormData>(
    updateProviderAction,
    {},
  );
  const [apiKey, setApiKey] = useState("");
  // Secret input is cleared after every action result; it must not survive a failed or successful submission.
  useEffect(() => {
    void updateState; // Every result, including failure, clears the secret.
    setApiKey("");
  }, [updateState]);

  const isWaitingOAuth =
    effectiveAuthMode === "oauth" && oauthSession?.status === "waiting";

  return (
    <ProviderDialog
      // Close after a clean save; keep a refresh warning visible.
      open={
        open &&
        (updateState.savedAt === savedAtWhenOpened ||
          Boolean(updateState.warning))
      }
      onOpenChange={(next) => {
        if (next) {
          // Discard edits abandoned in a previous opening.
          const initialPreset = piProviderPresets.find(
            (preset) => preset.format === provider.format,
          );
          const initialSupportsOAuth = Boolean(
            initialPreset?.authModes?.includes("oauth"),
          );
          const initialSupportsApiKey =
            !provider.format.startsWith("pi:") ||
            !initialPreset?.authModes ||
            initialPreset.authModes.includes("api_key");
          setFormat(provider.format);
          setBaseUrl(provider.baseUrl);
          setName(provider.name);
          setAuthMode(
            initialSupportsOAuth &&
              (provider.authType === "oauth" || !initialSupportsApiKey)
              ? "oauth"
              : "api_key",
          );
          setLoginMethod(initialPreset?.oauthMethods?.[0]?.id ?? "");
          setEnterpriseDomain("");
          setSavedAtWhenOpened(updateState.savedAt);
        } else {
          setApiKey("");
          cancelOAuthSession();
        }
        setOpen(next);
      }}
      title={t("editProvider")}
      maxWidth="max-w-2xl"
      trigger={
        <Button
          size="icon"
          variant="ghost"
          type="button"
          aria-label={t("editProvider")}
        >
          <Pencil aria-hidden="true" className="size-4" />
        </Button>
      }
    >
      {effectiveAuthMode === "oauth" ? (
        <form
          action={updateAction}
          className="flex min-h-0 flex-1 flex-col overflow-hidden"
        >
          <input type="hidden" name="workspace" value={slug} />
          <input type="hidden" name="providerId" value={provider.id} />
          <input type="hidden" name="format" value={format} />
          <input type="hidden" name="baseUrl" value={String(baseUrl)} />
          <DialogBody>
            {supportsOAuth && supportsApiKey && !isWaitingOAuth ? (
              <DialogField label={t("authMethod")} layout="row">
                <Tabs
                  variant="segment"
                  value={effectiveAuthMode}
                  onValueChange={(value) => {
                    const nextMode = value as ProviderAuthMode;
                    if (nextMode !== "oauth") cancelOAuthSession();
                    setAuthMode(nextMode);
                  }}
                >
                  <TabsList
                    aria-label={t("authMethod")}
                    className="bg-muted/60"
                  >
                    <TabsTrigger value="oauth" className="px-3 py-1 text-xs">
                      {t("browserSignIn")}
                    </TabsTrigger>
                    <TabsTrigger value="api_key" className="px-3 py-1 text-xs">
                      {t("apiKeyAuth")}
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
              </DialogField>
            ) : null}

            {isWaitingOAuth && oauthSession ? (
              <OAuthWaitingView
                fieldId={fieldId}
                oauthSession={oauthSession}
                manualInput={manualInput}
                onManualInputChange={setManualInput}
                oauthSubmitting={oauthSubmitting}
                onSubmitInput={(value) => void submitOAuthInput(value)}
                oauthError={oauthError}
              />
            ) : (
              <>
                <div className="grid gap-5 sm:grid-cols-2">
                  <DialogField
                    label={t("name")}
                    htmlFor={`${fieldId}-name`}
                    dirty={name !== provider.name}
                  >
                    <Input
                      id={`${fieldId}-name`}
                      leftIcon={<Cpu />}
                      name="name"
                      required
                      value={name}
                      onChange={setName}
                      className="w-full"
                    />
                  </DialogField>
                  <DialogField
                    label={t("format")}
                    dirty={format !== provider.format}
                  >
                    <FormSelect
                      value={format}
                      label={t("format")}
                      options={providerFormatOptions(piProviderPresets)}
                      onValueChange={(value) => {
                        cancelOAuthSession();
                        setFormat(value);
                        setBaseUrl("");
                        const nextPreset = piProviderPresets.find(
                          (preset) => preset.format === value,
                        );
                        setAuthMode(
                          nextPreset?.authModes?.includes("oauth")
                            ? "oauth"
                            : "api_key",
                        );
                        setLoginMethod(nextPreset?.oauthMethods?.[0]?.id ?? "");
                        setEnterpriseDomain("");
                      }}
                      className="w-full"
                    />
                  </DialogField>
                </div>
                <OAuthSetupFields
                  fieldId={fieldId}
                  format={format}
                  selectedPreset={selectedPreset}
                  loginMethod={loginMethod}
                  onLoginMethodChange={setLoginMethod}
                  enterpriseDomain={enterpriseDomain}
                  onEnterpriseDomainChange={setEnterpriseDomain}
                  baseUrl={baseUrl}
                  onBaseUrlChange={setBaseUrl}
                  oauthError={oauthError ?? oauthSession?.error ?? null}
                />
                <ActionMessage state={updateState} />
              </>
            )}
          </DialogBody>
          {isWaitingOAuth && oauthSession ? (
            <DialogFooter
              cancel={
                <Button
                  type="button"
                  variant="ghost"
                  size="md"
                  onClick={() => cancelOAuthSession(oauthSession.sessionId)}
                >
                  {t("oauthCancel")}
                </Button>
              }
            />
          ) : (
            <DialogFooter cancel={<DialogCancel />}>
              <Button
                type="button"
                variant={
                  provider.authType === "oauth" && format === provider.format
                    ? "secondary"
                    : "primary"
                }
                size="md"
                disabled={oauthStarting || !name.trim()}
                aria-busy={oauthStarting || undefined}
                onClick={() => void startOAuth()}
              >
                {oauthStarting ? (
                  <>
                    <Loader2
                      aria-hidden="true"
                      className="size-4 animate-spin"
                    />
                    {t("oauthStarting")}
                  </>
                ) : (
                  <>
                    <LogIn aria-hidden="true" className="size-4" />
                    {provider.authType === "oauth" && format === provider.format
                      ? t("oauthReconnect")
                      : t("oauthStartSignIn")}
                  </>
                )}
              </Button>
              {provider.authType === "oauth" && format === provider.format ? (
                <SubmitButton
                  error={updateState.error}
                  pendingLabel={t("saving")}
                  savedLabel={t("saved")}
                  disabled={
                    !name.trim() ||
                    (name === provider.name &&
                      String(baseUrl) === String(provider.baseUrl ?? ""))
                  }
                  variant="primary"
                  size="md"
                >
                  <Save aria-hidden="true" className="size-4" />
                  {t("saveChanges")}
                </SubmitButton>
              ) : null}
            </DialogFooter>
          )}
        </form>
      ) : (
        <form
          action={updateAction}
          className="flex min-h-0 flex-1 flex-col overflow-hidden"
        >
          <input type="hidden" name="workspace" value={slug} />
          <input type="hidden" name="providerId" value={provider.id} />
          <DialogBody>
            {supportsOAuth && supportsApiKey ? (
              <DialogField label={t("authMethod")} layout="row">
                <Tabs
                  variant="segment"
                  value={effectiveAuthMode}
                  onValueChange={(value) =>
                    setAuthMode(value as ProviderAuthMode)
                  }
                >
                  <TabsList
                    aria-label={t("authMethod")}
                    className="bg-muted/60"
                  >
                    <TabsTrigger value="oauth" className="px-3 py-1 text-xs">
                      {t("browserSignIn")}
                    </TabsTrigger>
                    <TabsTrigger value="api_key" className="px-3 py-1 text-xs">
                      {t("apiKeyAuth")}
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
              </DialogField>
            ) : null}
            <div className="grid gap-5 sm:grid-cols-2">
              <DialogField
                label={t("name")}
                htmlFor={`${fieldId}-name`}
                dirty={name !== provider.name}
              >
                <Input
                  id={`${fieldId}-name`}
                  leftIcon={<Cpu />}
                  name="name"
                  required
                  value={name}
                  onChange={setName}
                  className="w-full"
                />
              </DialogField>
              <DialogField
                label={t("format")}
                dirty={format !== provider.format}
              >
                <FormSelect
                  name="format"
                  value={format}
                  label={t("format")}
                  options={providerFormatOptions(piProviderPresets)}
                  onValueChange={(value) => {
                    setFormat(value);
                    setBaseUrl("");
                    const nextPreset = piProviderPresets.find(
                      (preset) => preset.format === value,
                    );
                    if (
                      nextPreset?.authModes?.includes("oauth") &&
                      !nextPreset.authModes.includes("api_key")
                    ) {
                      setAuthMode("oauth");
                    }
                    setLoginMethod(nextPreset?.oauthMethods?.[0]?.id ?? "");
                    setEnterpriseDomain("");
                  }}
                  className="w-full"
                />
              </DialogField>
            </div>
            <DialogField
              label={t("baseUrl")}
              htmlFor={`${fieldId}-baseUrl`}
              dirty={baseUrl !== provider.baseUrl}
              description={
                !isCustomProvider && selectedPreset?.baseUrl
                  ? t("leaveBlankToUseDefaultEndpoint", {
                      endpoint: selectedPreset.baseUrl,
                    })
                  : undefined
              }
            >
              <Input
                id={`${fieldId}-baseUrl`}
                leftIcon={<Link2 />}
                name="baseUrl"
                required={isCustomProvider}
                placeholder={
                  isCustomProvider
                    ? "https://api.example.com/v1"
                    : selectedPreset?.baseUrl
                }
                value={String(baseUrl)}
                onChange={(value) => setBaseUrl(value)}
                className="w-full"
              />
            </DialogField>
            <DialogField
              label={t("apiKey")}
              htmlFor={`${fieldId}-apiKey`}
              dirty={apiKey !== ""}
            >
              <Input
                id={`${fieldId}-apiKey`}
                leftIcon={<KeyRound />}
                name="apiKey"
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={setApiKey}
                placeholder={t("leaveBlankToKeepCurrentKey")}
                className="w-full"
              />
            </DialogField>
            <ActionMessage state={updateState} />
          </DialogBody>
          <DialogFooter cancel={<DialogCancel />}>
            <SubmitButton
              error={updateState.error}
              pendingLabel={t("saving")}
              savedLabel={t("saved")}
              variant="primary"
              size="md"
            >
              <Save aria-hidden="true" className="size-4" />
              {t("saveChanges")}
            </SubmitButton>
          </DialogFooter>
        </form>
      )}
    </ProviderDialog>
  );
}
