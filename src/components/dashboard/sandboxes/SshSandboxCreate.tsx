"use client";

import { FormCheckbox } from "@/components/ui/FormCheckbox";

import { Button } from "@/components/motion/button";
import { Input } from "@/components/motion/input";
import { FormSelect } from "@/components/ui/FormSelect";
import { useId, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

export function SshSandboxCreate({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations("console.sandboxes");
  const router = useRouter();
  const targetId = useId();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [targets, setTargets] = useState<{ id: string; name: string }[]>([]);
  async function show() {
    setOpen(true);
    setBusy(true);
    setError("");
    try {
      const response = await fetch(
        `/api/v1/workspaces/${workspaceId}/sandboxes/ssh`,
        { cache: "no-store" },
      );
      if (!response.ok) throw new Error();
      setTargets((await response.json()).targets);
    } catch {
      setError(t("sshOperationFailed"));
    } finally {
      setBusy(false);
    }
  }
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      const response = await fetch(
        `/api/v1/workspaces/${workspaceId}/sandboxes/ssh`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: data.get("name"),
            targetId: data.get("targetId"),
            acknowledgeHostAccess: data.get("ack") === "on",
          }),
        },
      );
      const result = await response.json();
      if (!response.ok || !result.id) throw new Error();
      router.push(
        result.consolePath ??
          `${window.location.pathname}/${encodeURIComponent(result.id)}`,
      );
      router.refresh();
    } catch {
      setError(t("sshOperationFailed"));
      setBusy(false);
    }
  }
  return (
    <div className="space-y-3">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={() => (open ? setOpen(false) : void show())}
        aria-expanded={open}
      >
        {t("sshCreate")}
      </Button>
      {open ? (
        <form
          onSubmit={create}
          className="w-full max-w-lg space-y-3 rounded-md border border-border bg-card p-4"
        >
          <p className="text-sm font-semibold">{t("sshCreate")}</p>
          <p className="text-xs leading-5 text-muted-foreground">
            {t("sshTargetHint")}
          </p>
          <fieldset disabled={busy} className="space-y-3 disabled:opacity-60">
            <div className="block space-y-1 text-xs">
              <Input
                label={t("sandboxName")}
                name="name"
                required
                maxLength={80}
                className="w-full"
              />
            </div>
            <label htmlFor={targetId} className="block space-y-1 text-xs">
              {t("sshApprovedTarget")}
              <FormSelect
                id={targetId}
                name="targetId"
                required
                defaultValue=""
                label={t("sshApprovedTarget")}
                options={[
                  { value: "", label: t("sshSelectTarget"), disabled: true },
                  ...targets.map((target) => ({
                    value: target.id,
                    label: target.name,
                  })),
                ]}
                className="w-full"
              />
            </label>
            {!targets.length && !busy ? (
              <p className="text-xs text-muted-foreground">
                {t("sshNoTargets")}
              </p>
            ) : null}
            <FormCheckbox
              name="ack"
              required
              label={t("sshHostAccessWarning")}
            />
            <Button
              type="submit"
              disabled={!targets.length}
              variant="primary"
              size="sm"
            >
              {t("sshCreate")}
            </Button>
          </fieldset>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </form>
      ) : null}
    </div>
  );
}
