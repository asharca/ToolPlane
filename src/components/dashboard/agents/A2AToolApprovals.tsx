"use client";
import { Button } from "@/components/motion/button/base";
import {
  ToolApproval,
  ToolApprovalCode,
} from "@/components/agents/tool-approval";
import { AnimatedBadge } from "@/components/motion/animated-badge";
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";

type Approval = {
  id: string;
  taskId: string;
  toolName: string;
  input: unknown;
  inputHash: string;
  status: string;
  expiresAt: string;
};
/** Decisions remain a same-origin human control plane, never an A2A message from a model. */
export function A2AToolApprovals({
  base,
  rootTaskId,
  taskId,
}: {
  base: string;
  rootTaskId: string;
  taskId: string;
}) {
  const t = useTranslations("console.agents.a2a.approvals");
  const [items, setItems] = useState<Approval[]>([]);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [observedAt, setObservedAt] = useState(0);
  const mounted = useRef(true);
  const decisionFlight = useRef<AbortController | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      decisionFlight.current?.abort();
    };
  }, []);
  useEffect(() => {
    // A decision restarts polling even when the task identity is unchanged.
    void revision;
    let alive = true,
      failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let flight: AbortController | undefined;
    async function load() {
      if (!alive || document.hidden || flight) return;
      const controller = new AbortController();
      flight = controller;
      const timeout = setTimeout(() => controller.abort(), 10_000);
      try {
        const params = new URLSearchParams({ rootTaskId, taskId });
        const response = await fetch(`${base}/approvals?${params}`, {
          credentials: "same-origin",
          cache: "no-store",
          signal: controller.signal,
        });
        if ([401, 403, 404].includes(response.status)) {
          failures = 3;
          throw new Error();
        }
        if (!response.ok) throw new Error();
        const body = await response.json();
        if (!Array.isArray(body.approvals) || body.approvals.length > 32)
          throw new Error();
        if (alive && !controller.signal.aborted) {
          setItems(body.approvals);
          setObservedAt(Date.now());
          setFailed(false);
          failures = 0;
        }
      } catch {
        if (alive) {
          failures++;
          setFailed(true);
          setItems([]);
        }
      } finally {
        clearTimeout(timeout);
        flight = undefined;
        if (alive && failures < 3 && !document.hidden)
          timer = setTimeout(load, 2500 * (1 + failures));
      }
    }
    const visible = () => {
      if (timer) clearTimeout(timer);
      if (document.hidden) flight?.abort();
      else if (failures < 3) void load();
    };
    document.addEventListener("visibilitychange", visible);
    void load();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      flight?.abort();
      document.removeEventListener("visibilitychange", visible);
    };
  }, [base, rootTaskId, taskId, revision]);
  async function decide(item: Approval, decision: "approved" | "denied") {
    if (decisionFlight.current) return;
    const controller = new AbortController();
    decisionFlight.current = controller;
    setBusy(item.id);
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(`${base}/approvals`, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          rootTaskId,
          taskId,
          approvalId: item.id,
          inputHash: item.inputHash,
          decision,
        }),
      });
      if (!response.ok) throw new Error();
      if (mounted.current) setRevision((value) => value + 1);
    } catch {
      if (mounted.current) {
        setFailed(true);
        setItems([]);
      }
    } finally {
      clearTimeout(timeout);
      decisionFlight.current = null;
      if (mounted.current) setBusy(null);
    }
  }
  return (
    <section aria-label={t("title")} className="space-y-3">
      <h5 className="text-sm font-semibold">{t("title")}</h5>
      <p className="text-xs text-muted-foreground">{t("hint")}</p>
      {failed ? (
        <div role="alert" className="space-y-2 text-sm text-muted-foreground">
          {t("failed")}{" "}
          <Button
            type="button"
            onClick={() => setRevision((value) => value + 1)}
            variant={"secondary"}
            size={"sm"}
          >
            {t("refresh")}
          </Button>
        </div>
      ) : null}
      {items.map((item) =>
        item.status === "pending" && Date.parse(item.expiresAt) > observedAt ? (
          <fieldset key={item.id} disabled={Boolean(busy)} className="contents">
            <ToolApproval
              tool={item.toolName}
              title={t("title")}
              description={t("hint")}
              status={busy === item.id ? "approving" : "pending"}
              defaultOpen
              parameters={[
                {
                  id: "input",
                  label: item.toolName,
                  value: (
                    <ToolApprovalCode
                      code={JSON.stringify(item.input, null, 2)}
                      language="json"
                    />
                  ),
                },
              ]}
              onApprove={() => void decide(item, "approved")}
              onDeny={() => void decide(item, "denied")}
            />
          </fieldset>
        ) : (
          <article key={item.id} className="space-y-2">
            <strong className="text-sm">{item.toolName}</strong>
            <AnimatedBadge
              status={
                item.status === "approved"
                  ? "success"
                  : item.status === "denied"
                    ? "danger"
                    : "neutral"
              }
            >
              {item.status}
            </AnimatedBadge>
            <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all text-xs">
              {JSON.stringify(item.input, null, 2)}
            </pre>
          </article>
        ),
      )}
    </section>
  );
}
