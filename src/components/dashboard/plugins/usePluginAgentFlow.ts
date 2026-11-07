"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { AgentPiPackageOption } from "../agents/AgentSettingsForm";

export type PluginSelectionResult =
  | "selected"
  | "duplicate"
  | "limit"
  | "incompatible"
  | "unavailable"
  | "unauthorized"
  | "failed"
  | "busy";

export function usePluginAgentFlow({
  slug,
  agentId,
  onSelect,
}: {
  slug: string;
  agentId: string;
  onSelect: (
    listingId: string,
    options: AgentPiPackageOption[],
  ) => PluginSelectionResult;
}) {
  const query = useSearchParams();
  const listingId =
    query.get("settings") === "piPackages" ? query.get("plugin") : null;
  const [nonce, setNonce] = useState("");
  const [result, setResult] = useState<PluginSelectionResult | null>(null);
  const select = useRef(onSelect);
  const consumed = useRef<string | null>(null);
  useEffect(() => {
    select.current = onSelect;
  });
  useEffect(() => {
    setNonce(crypto.randomUUID());
  }, []);
  useEffect(() => {
    if (!nonce) return;
    if (!listingId) consumed.current = null;
    const controller = new AbortController();
    let busy = false;
    const channel =
      typeof BroadcastChannel !== "undefined"
        ? new BroadcastChannel(`toolplane-plugin-${nonce}`)
        : null;
    async function receive(id: string): Promise<PluginSelectionResult> {
      if (busy) return "busy";
      busy = true;
      try {
        const response = await fetch(
          `/api/v1/workspaces/${encodeURIComponent(slug)}/agents/${encodeURIComponent(agentId)}/plugins/options`,
          { cache: "no-store", signal: controller.signal },
        );
        let outcome: PluginSelectionResult;
        if (response.status === 401 || response.status === 403)
          outcome = "unauthorized";
        else if (!response.ok) outcome = "failed";
        else {
          const data = await response.json();
          if (controller.signal.aborted) return "failed";
          outcome = Array.isArray(data.plugins)
            ? select.current(id, data.plugins)
            : "failed";
        }
        if (!controller.signal.aborted) setResult(outcome);
        return outcome;
      } catch {
        if (!controller.signal.aborted) setResult("failed");
        return "failed";
      } finally {
        busy = false;
      }
    }
    if (listingId && consumed.current !== listingId) {
      void receive(listingId).then((outcome) => {
        if (
          controller.signal.aborted ||
          (outcome !== "selected" && outcome !== "duplicate")
        )
          return;
        consumed.current = listingId;
        // Consume only the selection intent; retain the open settings tab without navigation.
        const url = new URL(window.location.href);
        if (url.searchParams.get("plugin") === listingId) {
          url.searchParams.delete("plugin");
          window.history.replaceState(window.history.state, "", url);
        }
      });
    }
    if (channel)
      channel.onmessage = async ({ data }) => {
        if (
          data?.type !== "select" ||
          data.workspace !== slug ||
          data.agentId !== agentId ||
          typeof data.listingId !== "string" ||
          typeof data.requestId !== "string"
        )
          return;
        const outcome = await receive(data.listingId);
        if (!controller.signal.aborted)
          channel.postMessage({
            type: "ack",
            requestId: data.requestId,
            listingId: data.listingId,
            result: outcome,
          });
      };
    return () => {
      controller.abort();
      channel?.close();
    };
  }, [nonce, slug, agentId, listingId]);
  return {
    context: new URLSearchParams({
      returnAgent: agentId,
      ...(nonce ? { pluginChannel: nonce } : {}),
    }).toString(),
    result,
    clearResult: () => setResult(null),
  };
}
