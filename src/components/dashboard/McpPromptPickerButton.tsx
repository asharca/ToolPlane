"use client";
import { Button } from "@/components/motion/button";
import {
  CenterMorphModal,
  CenterMorphModalContent,
} from "@/components/motion/center-morph-modal";
import { Input } from "@/components/motion/input";
import {
  DialogBody,
  DialogCancel,
  DialogField,
  DialogFooter,
  DialogHeader,
} from "@/components/dashboard/dialog";

import {
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useId,
  useState,
} from "react";
import { useTranslations } from "next-intl";
import { ChevronLeft, Loader2, ScrollText } from "lucide-react";

type McpPromptOption = {
  deploymentId: string;
  serverName: string;
  name: string;
  title?: string;
  description?: string;
  arguments: Array<{
    name: string;
    title?: string;
    description?: string;
    required: boolean;
  }>;
};

export function McpPromptPickerButton({
  apiPath,
  disabled,
  onError,
  onInsert,
  open: controlledOpen,
  onOpenChange,
  hideTrigger = false,
}: {
  apiPath?: string;
  disabled: boolean;
  onError: (message: string | null) => void;
  onInsert: (text: string) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  hideTrigger?: boolean;
}) {
  const t = useTranslations("console.agents");
  const common = useTranslations("common");
  const argumentId = useId();
  const [internalOpen, setOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const [loading, setLoading] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [prompts, setPrompts] = useState<McpPromptOption[]>([]);
  const [selected, setSelected] = useState<McpPromptOption | null>(null);
  const [argumentsValue, setArgumentsValue] = useState<Record<string, string>>(
    {},
  );
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef<AbortController | null>(null);

  const loadPrompts = useCallback(async () => {
    if (!apiPath) return;
    const controller = new AbortController();
    requestRef.current?.abort();
    requestRef.current = controller;
    setLoading(true);
    setResolving(false);
    setError(null);
    onError(null);
    try {
      const response = await fetch(apiPath, {
        cache: "no-store",
        signal: controller.signal,
      });
      const body = (await response.json().catch(() => ({}))) as {
        prompts?: McpPromptOption[];
        error?: string;
      };
      if (controller.signal.aborted) return;
      if (!response.ok)
        throw new Error(body.error || t("loadMcpPromptsFailed"));
      setPrompts(Array.isArray(body.prompts) ? body.prompts : []);
    } catch (cause) {
      if (controller.signal.aborted) return;
      const message =
        cause instanceof Error ? cause.message : t("loadMcpPromptsFailed");
      setError(message);
      onError(message);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [apiPath, onError, t]);

  const setDialogOpen = useCallback(
    (next: boolean) => {
      setOpen(next);
      onOpenChange?.(next);
      if (!next) {
        requestRef.current?.abort();
        setSelected(null);
        setArgumentsValue({});
        setError(null);
        return;
      }
    },
    [onOpenChange],
  );

  const loadOpenedPrompts = useEffectEvent(() => {
    void loadPrompts();
  });
  useEffect(() => {
    if (!open || !apiPath) return;
    const timer = window.setTimeout(() => loadOpenedPrompts(), 0);
    return () => {
      window.clearTimeout(timer);
      requestRef.current?.abort();
    };
  }, [open, apiPath]);

  const choosePrompt = useCallback((prompt: McpPromptOption) => {
    setSelected(prompt);
    setArgumentsValue(
      Object.fromEntries(
        prompt.arguments.map((argument) => [argument.name, ""]),
      ),
    );
    setError(null);
  }, []);

  const insertPrompt = useCallback(async () => {
    if (!apiPath || !selected) return;
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
          deploymentId: selected.deploymentId,
          name: selected.name,
          arguments: argumentsValue,
        }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        text?: string;
        error?: string;
      };
      if (controller.signal.aborted) return;
      if (!response.ok || typeof body.text !== "string") {
        throw new Error(body.error || t("resolveMcpPromptFailed"));
      }
      onInsert(body.text);
      setDialogOpen(false);
    } catch (cause) {
      if (controller.signal.aborted) return;
      const message =
        cause instanceof Error ? cause.message : t("resolveMcpPromptFailed");
      setError(message);
      onError(message);
    } finally {
      if (!controller.signal.aborted) setResolving(false);
    }
  }, [apiPath, argumentsValue, onError, onInsert, selected, setDialogOpen, t]);

  if (!apiPath) return null;
  const selectedLabel = selected?.title ?? selected?.name;

  return (
    <>
      {!hideTrigger && (
        <Button
          type="button"
          disabled={disabled}
          aria-label={t("openMcpPrompts")}
          title={t("openMcpPrompts")}
          onClick={() => setDialogOpen(true)}
          variant="ghost"
          size="icon"
          className="flex shrink-0 items-center justify-center"
        >
          <ScrollText className="size-[17px]" />
        </Button>
      )}
      <CenterMorphModal open={open} onOpenChange={setDialogOpen}>
        <CenterMorphModalContent
          ariaLabel={selectedLabel ?? t("mcpPrompts")}
          closeButtonLabel={common("close")}
          className="flex max-h-[calc(100dvh-6rem)] w-full max-w-xl flex-col"
        >
          <DialogHeader
            className="border-b border-border"
            icon={
              selected ? (
                <Button
                  type="button"
                  onClick={() => {
                    setSelected(null);
                    setArgumentsValue({});
                    setError(null);
                  }}
                  aria-label={common("back")}
                  title={common("back")}
                  variant="ghost"
                  size="icon"
                  className="-ml-2 size-8 shrink-0"
                >
                  <ChevronLeft className="size-4" />
                </Button>
              ) : (
                <ScrollText className="size-4 shrink-0 text-muted-foreground" />
              )
            }
            title={
              <span className="min-w-0 truncate">
                {selected ? selectedLabel : t("mcpPrompts")}
              </span>
            }
            description={
              selected ? (
                <span className="block truncate">{selected.serverName}</span>
              ) : undefined
            }
          />
          {loading ? (
            <div className="flex min-h-44 flex-1 items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 size-4 animate-spin" />
              {common("loading")}
            </div>
          ) : selected ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void insertPrompt();
              }}
              className="flex min-h-0 flex-1 flex-col"
            >
              <DialogBody>
                {selected.description ? (
                  <p className="text-sm leading-5 text-muted-foreground">
                    {selected.description}
                  </p>
                ) : null}
                {selected.arguments.map((argument) => (
                  <DialogField
                    key={argument.name}
                    htmlFor={`${argumentId}-${argument.name}`}
                    dirty={(argumentsValue[argument.name] ?? "") !== ""}
                    label={
                      <>
                        {argument.title ?? argument.name}
                        {argument.required ? (
                          <span className="text-destructive">*</span>
                        ) : null}
                      </>
                    }
                  >
                    <Input
                      id={`${argumentId}-${argument.name}`}
                      value={argumentsValue[argument.name] ?? ""}
                      onChange={(value) =>
                        setArgumentsValue((current) => ({
                          ...current,
                          [argument.name]: value,
                        }))
                      }
                      required={argument.required}
                      maxLength={20_000}
                      placeholder={argument.description ?? argument.name}
                      className="w-full"
                    />
                  </DialogField>
                ))}
                {error ? (
                  <p role="alert" className="text-sm text-destructive">
                    {error}
                  </p>
                ) : null}
              </DialogBody>
              <DialogFooter cancel={<DialogCancel />}>
                <Button
                  type="submit"
                  disabled={resolving}
                  variant="primary"
                  size="md"
                >
                  {resolving ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <ScrollText className="size-4" />
                  )}
                  {t("insertMcpPrompt")}
                </Button>
              </DialogFooter>
            </form>
          ) : (
            <DialogBody className="space-y-1 p-3">
              {error ? (
                <p role="alert" className="px-2 py-2 text-sm text-destructive">
                  {error}
                </p>
              ) : null}
              {prompts.length ? (
                prompts.map((prompt) => (
                  <Button
                    key={`${prompt.deploymentId}:${prompt.name}`}
                    type="button"
                    onClick={() => choosePrompt(prompt)}
                    variant="ghost"
                    size="lg"
                    className="w-full min-w-0 justify-start text-left"
                  >
                    <ScrollText className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-foreground">
                        {prompt.title ?? prompt.name}
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                        {prompt.serverName}
                      </span>
                      {prompt.description ? (
                        <span className="mt-1 block line-clamp-2 text-xs leading-4 text-muted-foreground">
                          {prompt.description}
                        </span>
                      ) : null}
                    </span>
                    {prompt.arguments.length ? (
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {prompt.arguments.length}
                      </span>
                    ) : null}
                  </Button>
                ))
              ) : (
                <p className="px-2 py-8 text-center text-sm text-muted-foreground">
                  {t("noMcpPrompts")}
                </p>
              )}
            </DialogBody>
          )}
        </CenterMorphModalContent>
      </CenterMorphModal>
    </>
  );
}
