"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button, ButtonLink } from "@/components/motion/button";
import { FormSelect } from "@/components/ui/FormSelect";
import type { PluginSelectionResult } from "./usePluginAgentFlow";

type Candidate = {
  id: string;
  name: string;
  packageCount: number;
  selected: boolean;
};

export function PluginAgentChooser({
  workspace,
  listingId,
  agents,
  canManage,
  installed,
  compatible,
  available,
  returnAgent,
  pluginChannel,
  version,
  counts,
  children,
}: {
  workspace: string;
  listingId: string;
  agents: Candidate[];
  canManage: boolean;
  installed: boolean;
  compatible: boolean;
  available: boolean;
  returnAgent: string;
  pluginChannel: string;
  version: string;
  counts: { skills: number; extensions: number; mcp: number };
  children?: ReactNode;
}) {
  const t = useTranslations("console.plugins.flow");
  const id = useId();
  const router = useRouter();
  const pathname = usePathname();
  const query = useSearchParams();
  const [target, setTarget] = useState(returnAgent);
  const [status, setStatus] = useState<
    PluginSelectionResult | "waiting" | "noReceiver" | null
  >(null);
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);
  const candidate = agents.find((agent) => agent.id === target);
  const useChannel = Boolean(pluginChannel && target === returnAgent);
  const reason = !canManage
    ? "unauthorized"
    : !available
      ? "unavailable"
      : !compatible
        ? "incompatible"
        : !agents.length
          ? "noAgents"
          : target && !candidate
            ? "invalidTarget"
            : candidate &&
                candidate.packageCount >= 16 &&
                !candidate.selected &&
                !useChannel
              ? "limit"
              : null;
  const href = `/app/${encodeURIComponent(workspace)}/agents/${encodeURIComponent(target)}?settings=piPackages&plugin=${encodeURIComponent(listingId)}`;
  function continueToAgent() {
    if (!candidate || reason) return;
    if (!useChannel) {
      router.push(href);
      return;
    }
    cleanup.current?.();
    if (typeof BroadcastChannel === "undefined") {
      setStatus("noReceiver");
      return;
    }
    const channel = new BroadcastChannel(`toolplane-plugin-${pluginChannel}`);
    const requestId = crypto.randomUUID();
    setStatus("waiting");
    const timer = window.setTimeout(() => {
      channel.close();
      setStatus("noReceiver");
    }, 10000);
    cleanup.current = () => {
      window.clearTimeout(timer);
      channel.close();
    };
    channel.onmessage = ({ data }) => {
      if (
        data?.type !== "ack" ||
        data.requestId !== requestId ||
        data.listingId !== listingId
      )
        return;
      const results: PluginSelectionResult[] = [
        "selected",
        "duplicate",
        "limit",
        "incompatible",
        "unavailable",
        "unauthorized",
        "failed",
        "busy",
      ];
      if (!results.includes(data.result)) return;
      cleanup.current?.();
      setStatus(data.result);
    };
    channel.postMessage({
      type: "select",
      requestId,
      listingId,
      workspace,
      agentId: target,
    });
  }
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {t(installed ? "workspaceAdded" : "installFirst")}
      </p>
      <p className="text-sm">{t("targetVersion", { version })}</p>
      <p className="text-xs text-muted-foreground">{t("counts", counts)}</p>
      <div className="grid gap-1 text-sm">
        <label htmlFor={id}>{t("chooseAgent")}</label>
        <FormSelect
          id={id}
          label={t("chooseAgent")}
          value={candidate?.id ?? ""}
          disabled={!canManage || status === "waiting"}
          options={[
            { value: "", label: t("chooseAgent") },
            ...agents.map((agent) => ({ value: agent.id, label: agent.name })),
          ]}
          onValueChange={(value) => {
            cleanup.current?.();
            setTarget(value);
            setStatus(null);
            const next = new URLSearchParams(query.toString());
            next.set("returnAgent", value);
            if (value !== returnAgent) next.delete("pluginChannel");
            router.replace(`${pathname}?${next.toString()}`, { scroll: false });
          }}
        />
      </div>
      {reason ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t(reason)}
        </p>
      ) : null}
      {candidate?.selected ? (
        <p className="text-sm text-muted-foreground">{t("duplicate")}</p>
      ) : null}
      {!installed && candidate && !reason ? children : null}
      {installed ? (
        <Button
          type="button"
          size="sm"
          disabled={!candidate || Boolean(reason) || status === "waiting"}
          onClick={continueToAgent}
        >
          {t(status === "waiting" ? "waiting" : "continue")}
        </Button>
      ) : null}
      {status ? (
        <p role="status" className="text-sm">
          {t(status)}
          {status === "selected" || status === "duplicate"
            ? ` ${t("returnOriginal")}`
            : ""}
        </p>
      ) : null}
      {status === "noReceiver" && candidate ? (
        <ButtonLink href={href} variant="secondary" size="sm">
          {t("openSettings")}
        </ButtonLink>
      ) : null}
      <p className="text-xs leading-5 text-muted-foreground">{t("steps")}</p>
      <p className="text-xs leading-5 text-muted-foreground">
        {t("prerequisites")}
      </p>
    </div>
  );
}
