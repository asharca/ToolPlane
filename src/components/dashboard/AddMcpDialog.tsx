"use client";

import { ArrowLeft, Loader2, Plug, Plus, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  DialogBody,
  DialogCancel,
  DialogFooter,
  DialogHeader,
} from "@/components/dashboard/dialog";
import {
  createDraftFormState,
  type DraftFormState,
  type IntakeErrorNotice,
  intakeFieldControlId,
  McpIntakeDraftCard,
  missingDraftFiles,
  useIntakeErrorFormatter,
} from "@/components/dashboard/McpIntakeDraftCard";
import { McpRegistryResults } from "@/components/dashboard/McpRegistryResults";
import {
  type RuntimeFileDraft,
  runtimeFilePathKey,
} from "@/components/dashboard/RuntimeFileDraftsInput";
import { notify } from "@/components/dashboard/Toaster";
import { Button, StatefulButton } from "@/components/motion/button";
import {
  CenterMorphModal,
  CenterMorphModalContent,
  CenterMorphModalTrigger,
} from "@/components/motion/center-morph-modal";
import {
  CONNECTOR_PRESETS,
  type ConnectorPreset,
  FEATURED_MCPS,
} from "@/lib/connectors/presets";
import {
  analyzeMcpSourceAction,
  createMcpFromIntakeAction,
  searchMcpRegistryAction,
} from "@/lib/workspace/mcp-intake-actions";
import { isMcpSearchQuery } from "@/lib/workspace/mcp-intake-input";
import type {
  McpIntakeCreateErrorCode,
  McpIntakeCreateItem,
  McpIntakeDraft,
  McpIntakeSource,
  McpRegistryItem,
} from "@/lib/workspace/mcp-intake-types";

const SEARCH_DEBOUNCE_MS = 400;
const ANALYZE_DEBOUNCE_MS = 500;

type Step = "input" | "review";

type SubmitErrorState = IntakeErrorNotice & {
  code: McpIntakeCreateErrorCode;
  itemId?: string;
};

function hasInvalidRuntimeFiles(files: RuntimeFileDraft[]): boolean {
  const keys = new Set<string>();
  return files.some(({ path, content }) => {
    const parts = path.split("/");
    const invalidPath =
      !path ||
      path !== path.trim() ||
      path.startsWith("/") ||
      path.includes("\\") ||
      /[^\x20-\uFFFF]|\x7f/.test(path) ||
      parts.some((part) => !part || part === "." || part === "..");
    if (invalidPath || content.includes("\0")) return true;
    const key = runtimeFilePathKey(path);
    if (!key || keys.has(key)) return true;
    keys.add(key);
    return false;
  });
}

function findFirstMissingFieldId(
  dialogId: string,
  drafts: McpIntakeDraft[],
): string | null {
  for (const draft of drafts) {
    if (draft.auth.type === "oauth" && draft.auth.client !== "missing") {
      continue;
    }
    const requiredMissing = draft.fields.find(
      (field) => field.required && !field.default?.trim(),
    );
    if (requiredMissing) {
      return intakeFieldControlId(dialogId, draft.id, requiredMissing.key);
    }
  }
  for (const draft of drafts) {
    if (draft.auth.type === "oauth" && draft.auth.client !== "missing") {
      continue;
    }
    const anyMissing = draft.fields.find((field) => !field.default?.trim());
    if (anyMissing) {
      return intakeFieldControlId(dialogId, draft.id, anyMissing.key);
    }
  }
  return null;
}

function buildDraftStateMap(
  drafts: McpIntakeDraft[],
): Record<string, DraftFormState> {
  const map: Record<string, DraftFormState> = {};
  for (const draft of drafts) {
    map[draft.id] = createDraftFormState(draft);
  }
  return map;
}

function normalizeSubmitValues(
  draft: McpIntakeDraft,
  rawValues: Record<string, string>,
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of draft.fields) {
    const raw = rawValues[field.key] ?? "";
    if (!raw.trim()) continue;
    const isBearerField =
      draft.kind === "remote" &&
      draft.config.includes(`Bearer \${${field.key}}`);
    values[field.key] = isBearerField
      ? raw
          .trim()
          .replace(/^Bearer\s+/i, "")
          .trim()
      : raw;
  }
  return values;
}

export function AddMcpDialog({
  slug,
  allowHttp,
  defaultOpen = false,
}: {
  slug: string;
  allowHttp: boolean;
  defaultOpen?: boolean;
}) {
  const t = useTranslations("console.mcp");
  const common = useTranslations("common");
  const statusT = useTranslations("console.sandboxes");
  const router = useRouter();
  const dialogId = useId();
  const inputId = `${dialogId}-intake-input`;
  const analyzeErrorId = `${dialogId}-analyze-error`;

  const [open, setOpen] = useState(defaultOpen);
  const [step, setStep] = useState<Step>("input");
  const [input, setInput] = useState("");
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<IntakeErrorNotice | null>(
    null,
  );

  const [registryItems, setRegistryItems] = useState<McpRegistryItem[]>([]);
  const [registryNextCursor, setRegistryNextCursor] = useState<string | null>(
    null,
  );
  const [registryLoading, setRegistryLoading] = useState(false);
  const [registryLoadingMore, setRegistryLoadingMore] = useState(false);
  const [registryError, setRegistryError] = useState<
    "notAuthorized" | "registryUnavailable" | null
  >(null);

  const [activeSource, setActiveSource] = useState<McpIntakeSource | null>(
    null,
  );
  const [drafts, setDrafts] = useState<McpIntakeDraft[]>([]);
  const [draftStates, setDraftStates] = useState<
    Record<string, DraftFormState>
  >({});
  const [analysisVersion, setAnalysisVersion] = useState(0);
  const [focusControlId, setFocusControlId] = useState<string | null>(null);

  const [jsonEditPending, setJsonEditPending] = useState(false);
  const [jsonEditError, setJsonEditError] = useState<IntakeErrorNotice | null>(
    null,
  );
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<SubmitErrorState | null>(null);
  const [invalidNameIds, setInvalidNameIds] = useState<Set<string>>(
    () => new Set(),
  );

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const debounceTimerRef = useRef<number | null>(null);
  const analyzeSeqRef = useRef(0);
  const searchSeqRef = useRef(0);
  const searchQueryRef = useRef("");
  const needsResetRef = useRef(false);

  const clearDebounce = () => {
    if (debounceTimerRef.current !== null) {
      window.clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
  };

  const resetAllState = () => {
    clearDebounce();
    analyzeSeqRef.current += 1;
    searchSeqRef.current += 1;
    searchQueryRef.current = "";
    needsResetRef.current = false;
    setStep("input");
    setInput("");
    setAnalyzing(false);
    setAnalyzeError(null);
    setRegistryItems([]);
    setRegistryNextCursor(null);
    setRegistryLoading(false);
    setRegistryLoadingMore(false);
    setRegistryError(null);
    setActiveSource(null);
    setDrafts([]);
    setDraftStates({});
    setFocusControlId(null);
    setJsonEditPending(false);
    setJsonEditError(null);
    setSubmitting(false);
    setSubmitError(null);
    setInvalidNameIds(new Set());
  };

  useEffect(() => {
    return () => {
      if (debounceTimerRef.current !== null) {
        window.clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      analyzeSeqRef.current += 1;
      searchSeqRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (step !== "review" || analysisVersion === 0 || !focusControlId) return;
    const frame = requestAnimationFrame(() => {
      document.getElementById(focusControlId)?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [step, analysisVersion, focusControlId]);

  const trimmedInput = input.trim();
  const isMultiline = input.includes("\n");
  const isSearch = isMcpSearchQuery(trimmedInput);

  const visiblePresets = useMemo<readonly ConnectorPreset[]>(() => {
    if (!trimmedInput || !isSearch) return [];
    const query = trimmedInput.toLowerCase();
    return CONNECTOR_PRESETS.filter(
      (preset) =>
        preset.name.toLowerCase().includes(query) ||
        preset.keywords.some(
          (keyword) =>
            keyword.toLowerCase().includes(query) ||
            query.includes(keyword.toLowerCase()),
        ),
    );
  }, [trimmedInput, isSearch]);

  const visibleFeatured = useMemo(() => {
    if (!trimmedInput) return FEATURED_MCPS;
    if (!isSearch) return [];
    const query = trimmedInput.toLowerCase();
    return FEATURED_MCPS.filter((item) =>
      item.name.toLowerCase().includes(query),
    );
  }, [trimmedInput, isSearch]);

  const selectedDrafts = useMemo(
    () => drafts.filter((draft) => draftStates[draft.id]?.selected ?? true),
    [drafts, draftStates],
  );

  const singleSelectedDraft =
    selectedDrafts.length === 1 ? selectedDrafts[0] : null;
  const singleSelectedState = singleSelectedDraft
    ? draftStates[singleSelectedDraft.id]
    : null;
  const isSingleOAuthSignIn = Boolean(
    singleSelectedDraft &&
      singleSelectedDraft.auth.type === "oauth" &&
      singleSelectedDraft.auth.client !== "missing" &&
      (singleSelectedState?.authMode ?? "oauth") === "oauth",
  );

  const hasMissingRequired = useMemo(
    () =>
      selectedDrafts.some((draft) => {
        const state = draftStates[draft.id];
        if (!state) return false;
        if (
          draft.auth.type === "oauth" &&
          draft.auth.client !== "missing" &&
          state.authMode === "oauth"
        ) {
          return false;
        }
        return draft.fields.some(
          (field) => field.required && !(state.values[field.key] ?? "").trim(),
        );
      }),
    [selectedDrafts, draftStates],
  );

  const formatError = useIntakeErrorFormatter();

  const applyDraftsToReview = (
    source: McpIntakeSource,
    nextDrafts: McpIntakeDraft[],
  ) => {
    setActiveSource(source);
    setDrafts(nextDrafts);
    setDraftStates(buildDraftStateMap(nextDrafts));
    setFocusControlId(findFirstMissingFieldId(dialogId, nextDrafts));
    setAnalysisVersion((current) => current + 1);
    setJsonEditError(null);
    setSubmitError(null);
    setInvalidNameIds(new Set());
    setStep("review");
  };

  const runAnalyze = async (source: McpIntakeSource) => {
    clearDebounce();
    const seq = ++analyzeSeqRef.current;
    searchSeqRef.current += 1;
    setRegistryLoading(false);
    setRegistryLoadingMore(false);
    setAnalyzing(true);
    setAnalyzeError(null);

    try {
      const result = await analyzeMcpSourceAction({ workspace: slug, source });
      if (seq !== analyzeSeqRef.current) return;
      setAnalyzing(false);
      if (result.ok) {
        applyDraftsToReview(source, result.drafts);
      } else {
        setAnalyzeError({
          code: result.error,
          issue: result.issue,
          detail: result.detail,
        });
      }
    } catch {
      if (seq !== analyzeSeqRef.current) return;
      setAnalyzing(false);
      setAnalyzeError({ code: "invalidConfig" });
    }
  };

  const runRegistrySearch = async (query: string) => {
    clearDebounce();
    const seq = ++searchSeqRef.current;
    analyzeSeqRef.current += 1;
    searchQueryRef.current = query;
    setAnalyzing(false);
    setAnalyzeError(null);
    setRegistryLoading(true);
    setRegistryLoadingMore(false);
    setRegistryError(null);

    try {
      const result = await searchMcpRegistryAction({ workspace: slug, query });
      if (seq !== searchSeqRef.current) return;
      setRegistryLoading(false);
      if (result.ok) {
        setRegistryItems(result.items);
        setRegistryNextCursor(result.nextCursor);
      } else {
        setRegistryItems([]);
        setRegistryNextCursor(null);
        setRegistryError(result.error);
      }
    } catch {
      if (seq !== searchSeqRef.current) return;
      setRegistryLoading(false);
      setRegistryItems([]);
      setRegistryNextCursor(null);
      setRegistryError("registryUnavailable");
    }
  };

  const handleLoadMore = async () => {
    if (!registryNextCursor || registryLoading || registryLoadingMore) return;
    const seq = searchSeqRef.current;
    const query = searchQueryRef.current;
    setRegistryLoadingMore(true);
    setRegistryError(null);

    try {
      const result = await searchMcpRegistryAction({
        workspace: slug,
        query,
        cursor: registryNextCursor,
      });
      if (seq !== searchSeqRef.current) return;
      setRegistryLoadingMore(false);
      if (result.ok) {
        setRegistryItems((current) => {
          const seen = new Set(
            current.map((item) => `${item.name}@${item.version}`),
          );
          const appended = result.items.filter(
            (item) => !seen.has(`${item.name}@${item.version}`),
          );
          return [...current, ...appended];
        });
        setRegistryNextCursor(result.nextCursor);
      } else {
        setRegistryError(result.error);
      }
    } catch {
      if (seq !== searchSeqRef.current) return;
      setRegistryLoadingMore(false);
      setRegistryError("registryUnavailable");
    }
  };

  const handleInputChange = (nextValue: string) => {
    setInput(nextValue);
    clearDebounce();
    setAnalyzeError(null);

    const trimmed = nextValue.trim();
    if (!trimmed) {
      analyzeSeqRef.current += 1;
      searchSeqRef.current += 1;
      searchQueryRef.current = "";
      setAnalyzing(false);
      setRegistryLoading(false);
      setRegistryLoadingMore(false);
      setRegistryItems([]);
      setRegistryNextCursor(null);
      setRegistryError(null);
      return;
    }

    if (isMcpSearchQuery(trimmed)) {
      analyzeSeqRef.current += 1;
      setAnalyzing(false);
      setRegistryError(null);
      debounceTimerRef.current = window.setTimeout(() => {
        void runRegistrySearch(trimmed);
      }, SEARCH_DEBOUNCE_MS);
    } else {
      searchSeqRef.current += 1;
      searchQueryRef.current = "";
      setRegistryLoading(false);
      setRegistryLoadingMore(false);
      setRegistryItems([]);
      setRegistryNextCursor(null);
      setRegistryError(null);
      debounceTimerRef.current = window.setTimeout(() => {
        void runAnalyze({ kind: "text", text: trimmed });
      }, ANALYZE_DEBOUNCE_MS);
    }
  };

  const handleInputKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (isMultiline || event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    if (!trimmedInput) return;
    if (isSearch) {
      void runRegistrySearch(trimmedInput);
    } else {
      void runAnalyze({ kind: "text", text: trimmedInput });
    }
  };

  const handleSelectPreset = (preset: ConnectorPreset) => {
    void runAnalyze({ kind: "preset", presetId: preset.id });
  };

  const handleSelectRegistryItem = (item: McpRegistryItem) => {
    if (!item.supported) return;
    void runAnalyze({
      kind: "registry",
      name: item.name,
      version: item.version,
    });
  };

  const handleApplyEditedJson = async (editedJson: string) => {
    const source: McpIntakeSource = { kind: "text", text: editedJson };
    const seq = ++analyzeSeqRef.current;
    setJsonEditPending(true);
    setJsonEditError(null);

    try {
      const result = await analyzeMcpSourceAction({ workspace: slug, source });
      if (seq !== analyzeSeqRef.current) return;
      setJsonEditPending(false);
      if (result.ok) {
        applyDraftsToReview(source, result.drafts);
      } else {
        setJsonEditError({
          code: result.error,
          issue: result.issue,
          detail: result.detail,
        });
      }
    } catch {
      if (seq !== analyzeSeqRef.current) return;
      setJsonEditPending(false);
      setJsonEditError({ code: "invalidConfig" });
    }
  };

  const handleBackToInput = () => {
    clearDebounce();
    analyzeSeqRef.current += 1;
    setAnalyzing(false);
    setJsonEditPending(false);
    setJsonEditError(null);
    setSubmitError(null);
    setInvalidNameIds(new Set());
    setStep("input");
    requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
  };

  const updateDraftState = (
    draftId: string,
    patch: Partial<DraftFormState>,
  ) => {
    setDraftStates((current) => ({
      ...current,
      [draftId]: { ...current[draftId], ...patch },
    }));
    if (patch.name?.trim()) {
      setInvalidNameIds((current) => {
        if (!current.has(draftId)) return current;
        const next = new Set(current);
        next.delete(draftId);
        return next;
      });
    }
    setSubmitError((current) =>
      current && (!current.itemId || current.itemId === draftId)
        ? null
        : current,
    );
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting || jsonEditPending || !activeSource) return;
    if (selectedDrafts.length === 0) return;

    const missingNames = new Set<string>();
    for (const draft of selectedDrafts) {
      const st = draftStates[draft.id];
      if (!st?.name.trim()) {
        missingNames.add(draft.id);
      }
    }
    if (missingNames.size > 0) {
      setInvalidNameIds(missingNames);
      const [firstInvalidId] = missingNames;
      document.getElementById(`${dialogId}-name-${firstInvalidId}`)?.focus();
      return;
    }

    for (const draft of selectedDrafts) {
      const st = draftStates[draft.id];
      if (!st) continue;
      if (draft.insecureHttp && !allowHttp && !st.allowUnsafeHttp) {
        setSubmitError({
          code: "unsafeHttpConfirmationRequired",
          itemId: draft.id,
        });
        return;
      }
      if (draft.kind === "stdio" && hasInvalidRuntimeFiles(st.runtimeFiles)) {
        setSubmitError({
          code: "invalidRuntimeFile",
          itemId: draft.id,
        });
        return;
      }
      if (missingDraftFiles(draft, st.runtimeFiles).length) {
        setSubmitError({ code: "runtimeFileRequired", itemId: draft.id });
        return;
      }
    }

    const items: McpIntakeCreateItem[] = selectedDrafts.map((draft) => {
      const st = draftStates[draft.id];
      const oauthOnly =
        draft.auth.type === "oauth" && draft.fields.length === 0;
      const oauthAvailable =
        draft.auth.type === "oauth" && draft.auth.client !== "missing";
      const useOAuth = oauthOnly || (oauthAvailable && st.authMode === "oauth");
      return {
        id: draft.id,
        name: st.name.trim(),
        values: useOAuth ? {} : normalizeSubmitValues(draft, st.values),
        ...(useOAuth
          ? { authMode: "oauth" as const }
          : oauthAvailable
            ? { authMode: "token" as const }
            : {}),
        ...(draft.kind === "stdio"
          ? {
              network: st.network,
              runtimeFiles:
                st.runtimeFiles.length > 0 ? st.runtimeFiles : undefined,
            }
          : {}),
        ...(draft.insecureHttp && !allowHttp
          ? { allowUnsafeHttp: st.allowUnsafeHttp }
          : {}),
      };
    });

    setSubmitting(true);
    setSubmitError(null);

    try {
      const result = await createMcpFromIntakeAction({
        workspace: slug,
        source: activeSource,
        items,
      });
      if (result.ok) {
        if (result.deployments.length === 1) {
          const created = result.deployments[0];
          if (isSingleOAuthSignIn && created.oauthStartUrl) {
            window.location.assign(created.oauthStartUrl);
            return;
          }
          setSubmitting(false);
          handleOpenChange(false);
          router.push(`/app/${encodeURIComponent(slug)}/mcp/${created.id}`);
        } else {
          setSubmitting(false);
          handleOpenChange(false);
          router.refresh();
          if (result.deployments.length > 1) {
            notify(
              t("intake.createdMultiple", {
                count: result.deployments.length,
              }),
            );
          }
        }
      } else {
        setSubmitting(false);
        setSubmitError({
          code: result.error,
          issue: result.issue,
          detail: result.detail,
          itemId: result.itemId,
        });
      }
    } catch {
      setSubmitting(false);
      setSubmitError({ code: "connectionCreateFailed" });
    }
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      clearDebounce();
      analyzeSeqRef.current += 1;
      searchSeqRef.current += 1;
      needsResetRef.current = true;
    } else if (needsResetRef.current) {
      resetAllState();
    }
    setOpen(nextOpen);
  };

  return (
    <CenterMorphModal open={open} onOpenChange={handleOpenChange}>
      <CenterMorphModalTrigger>
        <Button type="button" variant="primary" size="md">
          <Plus className="size-4" aria-hidden="true" />
          {t("addCustomMcp")}
        </Button>
      </CenterMorphModalTrigger>

      <CenterMorphModalContent
        ariaLabel={t("addCustomMcp")}
        closeButtonLabel={common("cancel")}
        onExitComplete={resetAllState}
        className="flex max-h-[calc(100dvh-4rem)] w-full max-w-5xl flex-col"
      >
        <DialogHeader
          title={t("addCustomMcp")}
          icon={<Plug className="size-4" aria-hidden="true" />}
        />

        {step === "input" ? (
          <>
            <DialogBody className="space-y-4">
              <div className="space-y-2">
                <label htmlFor={inputId} className="sr-only">
                  {t("intake.inputPlaceholder")}
                </label>
                <div className="relative">
                  <textarea
                    ref={inputRef}
                    id={inputId}
                    value={input}
                    rows={isMultiline ? 6 : 1}
                    spellCheck={false}
                    placeholder={t("intake.inputPlaceholder")}
                    aria-invalid={Boolean(analyzeError) || undefined}
                    aria-describedby={analyzeError ? analyzeErrorId : undefined}
                    onChange={(event) => handleInputChange(event.target.value)}
                    onKeyDown={handleInputKeyDown}
                    className={
                      isMultiline
                        ? "block min-h-48 max-h-[28rem] w-full resize-y rounded-lg border border-border bg-muted/25 p-3 pr-10 font-mono text-xs leading-5 text-foreground placeholder:text-muted-foreground/60 outline-none transition-colors focus-visible:border-foreground/40 focus-visible:ring-2 focus-visible:ring-ring/40"
                        : "block h-11 w-full resize-none overflow-hidden rounded-lg border border-border bg-background py-2.5 pl-3.5 pr-10 text-sm leading-6 text-foreground placeholder:text-muted-foreground/60 outline-none transition-colors focus-visible:border-foreground/40 focus-visible:ring-2 focus-visible:ring-ring/40"
                    }
                  />
                  {input.length > 0 ? (
                    <button
                      type="button"
                      onClick={() => {
                        handleInputChange("");
                        inputRef.current?.focus();
                      }}
                      aria-label={t("clearSearch")}
                      className="absolute right-2 top-2 inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <X className="size-4" aria-hidden="true" />
                    </button>
                  ) : null}
                </div>

                {analyzing ? (
                  <div
                    role="status"
                    className="flex items-center gap-2 text-xs text-muted-foreground"
                  >
                    <Loader2
                      className="size-3.5 animate-spin"
                      aria-hidden="true"
                    />
                    <span>{t("intake.analyzing")}</span>
                  </div>
                ) : null}

                {analyzeError ? (
                  <p
                    id={analyzeErrorId}
                    role="alert"
                    className="text-sm text-destructive"
                  >
                    {formatError(analyzeError)}
                  </p>
                ) : null}
              </div>

              {!trimmedInput || isSearch ? (
                <McpRegistryResults
                  presets={visiblePresets}
                  onSelectPreset={handleSelectPreset}
                  featured={visibleFeatured}
                  onSelectFeatured={(url) =>
                    void runAnalyze({ kind: "text", text: url })
                  }
                  isSearching={isSearch}
                  registryItems={registryItems}
                  registryLoading={registryLoading}
                  registryLoadingMore={registryLoadingMore}
                  registryNextCursor={registryNextCursor}
                  registryError={registryError}
                  onSelectRegistryItem={handleSelectRegistryItem}
                  onLoadMore={handleLoadMore}
                  busy={analyzing}
                />
              ) : null}
            </DialogBody>

            <DialogFooter cancel={<DialogCancel />}>
              {trimmedInput ? (
                <Button
                  type="button"
                  variant="primary"
                  size="md"
                  disabled={analyzing}
                  onClick={() =>
                    void runAnalyze({ kind: "text", text: trimmedInput })
                  }
                >
                  {t("intake.continue")}
                </Button>
              ) : null}
            </DialogFooter>
          </>
        ) : (
          <form
            onSubmit={handleSubmit}
            noValidate
            className="flex min-h-0 flex-1 flex-col"
          >
            <DialogBody className="space-y-4">
              {drafts.map((draft) => {
                const state =
                  draftStates[draft.id] ?? createDraftFormState(draft);
                const draftError =
                  submitError && submitError.itemId === draft.id
                    ? submitError
                    : null;
                return (
                  <McpIntakeDraftCard
                    key={`${analysisVersion}:${draft.id}`}
                    dialogId={dialogId}
                    draft={draft}
                    state={state}
                    onChange={(patch) => updateDraftState(draft.id, patch)}
                    multi={drafts.length > 1}
                    multiSelected={selectedDrafts.length > 1}
                    allowHttp={allowHttp}
                    disabled={submitting || jsonEditPending}
                    nameInvalid={invalidNameIds.has(draft.id)}
                    error={draftError}
                    jsonEditPending={jsonEditPending}
                    jsonEditError={drafts.length === 1 ? jsonEditError : null}
                    onApplyEditedJson={
                      drafts.length === 1 ? handleApplyEditedJson : undefined
                    }
                  />
                );
              })}

              {hasMissingRequired ? (
                <p className="text-xs text-muted-foreground">
                  {t("intake.setupRequiredNote", {
                    status: statusT("statusSetupRequired"),
                  })}
                </p>
              ) : null}

              {submitError && !submitError.itemId ? (
                <p role="alert" className="text-sm text-destructive">
                  {formatError(submitError)}
                </p>
              ) : null}
            </DialogBody>

            <DialogFooter
              start={
                <Button
                  type="button"
                  variant="ghost"
                  size="md"
                  disabled={submitting || jsonEditPending}
                  onClick={handleBackToInput}
                >
                  <ArrowLeft className="size-4" aria-hidden="true" />
                  {common("back")}
                </Button>
              }
              cancel={<DialogCancel disabled={submitting} />}
            >
              <StatefulButton
                type="submit"
                variant="primary"
                size="md"
                state={submitting ? "loading" : "idle"}
                loadingText={
                  isSingleOAuthSignIn
                    ? t("intake.signingIn")
                    : t("intake.adding")
                }
                disabled={
                  submitting || jsonEditPending || selectedDrafts.length === 0
                }
              >
                {isSingleOAuthSignIn && singleSelectedDraft
                  ? t("intake.signInWith", {
                      name:
                        singleSelectedState?.name.trim() ||
                        singleSelectedDraft.name,
                    })
                  : drafts.length > 1
                    ? t("intake.addCount", { count: selectedDrafts.length })
                    : t("intake.addSingle")}
              </StatefulButton>
            </DialogFooter>
          </form>
        )}
      </CenterMorphModalContent>
    </CenterMorphModal>
  );
}
