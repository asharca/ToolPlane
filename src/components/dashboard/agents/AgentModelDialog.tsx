"use client";

import {
  startTransition,
  useActionState,
  useCallback,
  useEffect,
  useState,
  type ReactElement,
} from "react";
import { useRouter } from "next/navigation";
import { updateAgentModelAction, type ActionState } from "@/lib/agents/actions";
import { agentRuntimeSupportsProviderFormat } from "@/lib/agents/runtime-kind";
import {
  ModelPicker,
  type ModelProviderOption,
  type ModelSelection,
} from "@/components/dashboard/models/ModelPicker";

type ModelAgent = {
  id: string;
  name: string;
  runtimeKind: string | null;
  providerId: string | null;
  providerIds: string[];
  model: string | null;
};

export function AgentModelDialog({
  open,
  onOpenChange,
  slug,
  agent,
  providers,
  trigger,
  confirmationMessage,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  slug: string;
  agent: ModelAgent;
  providers: (ModelProviderOption & { format: string })[];
  trigger: ReactElement;
  confirmationMessage?: string;
}) {
  const router = useRouter();
  const [pendingSelection, setPendingSelection] =
    useState<ModelSelection | null>(null);
  const [state, formAction, isPending] = useActionState<ActionState, FormData>(
    updateAgentModelAction,
    {},
  );
  const compatibleProviders = providers.filter((provider) =>
    agentRuntimeSupportsProviderFormat(
      agent.runtimeKind ?? "",
      provider.format,
    ),
  );
  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      setPendingSelection(null);
      onOpenChange(nextOpen);
    },
    [onOpenChange],
  );
  useEffect(() => {
    if (!state.savedAt) return;
    onOpenChange(false);
    router.refresh();
  }, [onOpenChange, router, state.savedAt]);
  const selectModel = useCallback(
    ({ providerId, model }: ModelSelection) => {
      if (confirmationMessage && !window.confirm(confirmationMessage)) return;
      const data = new FormData();
      data.set("workspace", slug);
      data.set("agentId", agent.id);
      data.set("providerId", providerId);
      data.set("model", model);
      setPendingSelection({ providerId, model });
      startTransition(() => formAction(data));
    },
    [agent.id, confirmationMessage, formAction, slug],
  );
  return (
    <ModelPicker
      open={open}
      onOpenChange={handleOpenChange}
      providers={compatibleProviders}
      value={
        agent.providerId && agent.model
          ? { providerId: agent.providerId, model: agent.model }
          : null
      }
      pending={isPending}
      pendingValue={pendingSelection}
      error={state.error}
      closeOnSelect={false}
      onSelect={selectModel}
      onConfigure={() =>
        router.push(`/app/${encodeURIComponent(slug)}/providers`)
      }
      trigger={trigger}
    />
  );
}
