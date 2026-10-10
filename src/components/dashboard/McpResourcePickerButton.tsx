"use client";
import { Button } from "@/components/motion/button";
import {
  CenterMorphModal,
  CenterMorphModalContent,
} from "@/components/motion/center-morph-modal";

import {
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";
import { useTranslations } from "next-intl";
import { Database, Loader2 } from "lucide-react";

type McpResourceOption = {
  kind: "resource";
  id: string;
  deploymentId: string;
  label: string;
  description?: string;
};

export function McpResourcePickerButton({
  apiPath,
  disabled,
  hideTrigger = false,
  onError,
  onInsert,
  open: controlledOpen,
  onOpenChange,
}: {
  apiPath?: string;
  disabled: boolean;
  hideTrigger?: boolean;
  onError: (message: string | null) => void;
  onInsert: (text: string) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const t = useTranslations("console.agents");
  const common = useTranslations("common");
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const [loading, setLoading] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [resources, setResources] = useState<McpResourceOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef<AbortController | null>(null);

  const setDialogOpen = useCallback(
    (next: boolean) => {
      setInternalOpen(next);
      onOpenChange?.(next);
      if (!next) {
        requestRef.current?.abort();
        setError(null);
      }
    },
    [onOpenChange],
  );

  const loadResources = useCallback(async () => {
    if (!apiPath) return;
    const controller = new AbortController();
    requestRef.current?.abort();
    requestRef.current = controller;
    setLoading(true);
    setResolving(false);
    setError(null);
    onError(null);
    try {
      const separator = apiPath.includes("?") ? "&" : "?";
      const response = await fetch(`${apiPath}${separator}section=resources`, {
        cache: "no-store",
        signal: controller.signal,
      });
      const body = (await response.json().catch(() => ({}))) as {
        items?: McpResourceOption[];
        error?: string;
      };
      if (controller.signal.aborted) return;
      if (!response.ok)
        throw new Error(body.error || t("loadMcpResourcesFailed"));
      setResources(
        Array.isArray(body.items)
          ? body.items.filter((item) => item?.kind === "resource")
          : [],
      );
    } catch (cause) {
      if (controller.signal.aborted) return;
      const message =
        cause instanceof Error ? cause.message : t("loadMcpResourcesFailed");
      setError(message);
      onError(message);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [apiPath, onError, t]);

  const loadOpenedResources = useEffectEvent(() => {
    void loadResources();
  });
  useEffect(() => {
    if (!open || !apiPath) return;
    const timer = window.setTimeout(() => loadOpenedResources(), 0);
    return () => {
      window.clearTimeout(timer);
      requestRef.current?.abort();
    };
  }, [apiPath, open]);

  const insertResource = useCallback(
    async (resource: McpResourceOption) => {
      if (!apiPath || resolving) return;
      const controller = new AbortController();
      requestRef.current?.abort();
      requestRef.current = controller;
      setResolving(true);
      setError(null);
      try {
        const response = await fetch(apiPath, {
          method: "POST",
          signal: controller.signal,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            kind: "resource",
            id: resource.id,
            deploymentId: resource.deploymentId,
          }),
        });
        const body = (await response.json().catch(() => ({}))) as {
          text?: string;
          error?: string;
        };
        if (controller.signal.aborted) return;
        if (!response.ok || typeof body.text !== "string") {
          throw new Error(body.error || t("resolveMcpResourceFailed"));
        }
        onInsert(body.text);
        setDialogOpen(false);
      } catch (cause) {
        if (controller.signal.aborted) return;
        const message =
          cause instanceof Error
            ? cause.message
            : t("resolveMcpResourceFailed");
        setError(message);
        onError(message);
      } finally {
        if (!controller.signal.aborted) setResolving(false);
      }
    },
    [apiPath, onError, onInsert, resolving, setDialogOpen, t],
  );

  if (!apiPath) return null;

  return (
    <>
      {!hideTrigger ? (
        <Button
          type="button"
          disabled={disabled}
          aria-label={t("openMcpResources")}
          title={t("openMcpResources")}
          onClick={() => setDialogOpen(true)}
          variant="ghost"
          size="icon"
          className="flex shrink-0 items-center justify-center"
        >
          <Database className="size-[17px]" />
        </Button>
      ) : null}
      <CenterMorphModal open={open} onOpenChange={setDialogOpen}>
        <CenterMorphModalContent
          ariaLabel={t("mcpResources")}
          closeButtonLabel={common("close")}
          className="flex max-h-[calc(100dvh-6rem)] w-full max-w-xl flex-col"
        >
          <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3">
            <h2 className="!text-sm !tracking-normal">{t("mcpResources")}</h2>
          </header>
          {loading ? (
            <div className="flex min-h-44 flex-1 items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 size-4 animate-spin" />
              {common("loading")}
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {error ? (
                <p role="alert" className="px-2 py-2 text-sm text-destructive">
                  {error}
                </p>
              ) : null}
              {resources.length ? (
                resources.map((resource) => (
                  <Button
                    key={`${resource.deploymentId}:${resource.id}`}
                    type="button"
                    disabled={resolving}
                    onClick={() => void insertResource(resource)}
                    variant="ghost"
                    size="lg"
                    className="w-full min-w-0 justify-start text-left"
                  >
                    <Database className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-foreground">
                        {resource.label}
                      </span>
                      {resource.description ? (
                        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                          {resource.description}
                        </span>
                      ) : null}
                      <span className="mt-1 block truncate font-mono text-[11px] text-muted-foreground">
                        {resource.id}
                      </span>
                    </span>
                    {resolving ? (
                      <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground" />
                    ) : null}
                  </Button>
                ))
              ) : (
                <p className="px-2 py-8 text-center text-sm text-muted-foreground">
                  {t("noMcpResources")}
                </p>
              )}
            </div>
          )}
        </CenterMorphModalContent>
      </CenterMorphModal>
    </>
  );
}
