"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/motion/button";
import { notify } from "../Toaster";

/** Configuration updates derive a private immutable release, never mutate a catalog version. */
export function PluginConfiguration({
  workspace,
  installId,
  canManage,
}: {
  workspace: string;
  installId: string;
  canManage: boolean;
}) {
  const t = useTranslations("console.plugins.capabilities");
  const errors = useTranslations("console.plugins.errors");
  const router = useRouter();
  const [config, setConfig] = useState("");
  const [features, setFeatures] = useState("");
  const [initial, setInitial] = useState({ config: "", features: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const endpoint = `/api/v1/workspaces/${encodeURIComponent(workspace)}/plugins/installs/${encodeURIComponent(installId)}/config`;
  useEffect(() => {
    const controller = new AbortController();
    void fetch(endpoint, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok)
          throw new Error(
            data.error && errors.has(data.error)
              ? errors(data.error)
              : t("loadFailed"),
          );
        if (controller.signal.aborted) return;
        const next = {
          config: JSON.stringify(data.config, null, 2),
          features: JSON.stringify(data.enabledFeatures ?? null, null, 2),
        };
        setConfig(next.config);
        setFeatures(next.features);
        setInitial(next);
        setLoaded(true);
      })
      .catch((failure) => {
        if (!controller.signal.aborted)
          setError(
            failure instanceof Error ? failure.message : t("loadFailed"),
          );
      });
    return () => controller.abort();
  }, [endpoint, t, errors]);
  async function save() {
    setBusy(true);
    setError("");
    try {
      const parsed: unknown = JSON.parse(config);
      const enabledFeatures: unknown = JSON.parse(features);
      if (
        !parsed ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        (enabledFeatures !== null &&
          (!Array.isArray(enabledFeatures) ||
            !enabledFeatures.every((feature) => typeof feature === "string")))
      )
        throw new Error(t("invalid"));
      const response = await fetch(endpoint, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ config: parsed, enabledFeatures }),
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(
          data.error && errors.has(data.error)
            ? errors(data.error)
            : t("saveFailed"),
        );
      setInitial({ config, features });
      notify(t("saved"));
      router.refresh();
    } catch (failure) {
      setError(
        failure instanceof SyntaxError
          ? t("invalid")
          : failure instanceof Error
            ? failure.message
            : t("saveFailed"),
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-4">
      <p className="text-xs leading-5 text-muted-foreground">
        {t("configHelp")}
      </p>
      {!loaded && !error ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t("loading")}
        </p>
      ) : null}
      {loaded ? (
        <>
          <label className="grid gap-2 text-sm">
            {t("config")}
            <textarea
              rows={8}
              spellCheck={false}
              disabled={!canManage || busy}
              className="w-full rounded-lg border border-border bg-background p-3 font-mono text-xs"
              value={config}
              onChange={(event) => setConfig(event.target.value)}
            />
          </label>
          <label className="grid gap-2 text-sm">
            {t("features")}
            <textarea
              rows={4}
              spellCheck={false}
              disabled={!canManage || busy}
              className="w-full rounded-lg border border-border bg-background p-3 font-mono text-xs"
              value={features}
              onChange={(event) => setFeatures(event.target.value)}
            />
            <span className="text-xs leading-5 text-muted-foreground">
              {t("featuresHelp")}
            </span>
          </label>
          {canManage ? (
            <Button
              type="button"
              size="sm"
              disabled={
                busy ||
                (config === initial.config && features === initial.features)
              }
              onClick={() => void save()}
            >
              {t(busy ? "saving" : "save")}
            </Button>
          ) : null}
        </>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
