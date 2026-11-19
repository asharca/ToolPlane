"use client";

import type { Dispatch, SetStateAction } from "react";
import { useTranslations } from "next-intl";
import { Box, Cable, Server, Trash2 } from "lucide-react";
import { Button, ButtonLink } from "@/components/motion/button/base";
import { FormSelect } from "@/components/ui/FormSelect";
import {
  EXTERNAL_SANDBOX_ACCESS,
  MAX_EXTERNAL_SANDBOXES,
  type ExternalSandboxAccess,
} from "@/lib/sandboxes/external";
import { DialogField } from "../dialog";
import { StatusBadge } from "../StatusBadge";
import type {
  AgentExternalSandbox,
  AgentOwnSandbox,
} from "./AgentSettingsForm";
import { SettingsSection } from "./SettingsSection";

export type ExternalSandboxAttachment = {
  sandboxId: string;
  access: ExternalSandboxAccess;
};

function kindLabel(kind: string) {
  return kind === "ssh"
    ? "sshMode"
    : kind === "connector"
      ? "connectorMode"
      : "docker";
}

/** The Agent's own sandbox and the external sandboxes it may reach. */
export function AgentSandboxSettings({
  hidden,
  slug,
  ownSandbox,
  externalSandboxes,
  attachments,
  setAttachments,
  dirty,
  onChange,
}: {
  hidden: boolean;
  slug: string;
  ownSandbox: AgentOwnSandbox | null;
  externalSandboxes: AgentExternalSandbox[];
  attachments: ExternalSandboxAttachment[];
  setAttachments: Dispatch<SetStateAction<ExternalSandboxAttachment[]>>;
  dirty: boolean;
  onChange: () => void;
}) {
  const t = useTranslations("console.agents");
  const s = useTranslations("console.sandboxes");
  return (
    <SettingsSection
      id="sandboxes"
      title={t("sandboxes")}
      className="space-y-5"
      hidden={hidden}
    >
      <DialogField label={t("ownSandbox")}>
        {ownSandbox ? (
          <div className="min-w-0 space-y-3 rounded-xl border border-border bg-card p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <ButtonLink
                href={`/app/${slug}/sandboxes/${ownSandbox.id}`}
                variant="ghost"
                size="sm"
              >
                <Box className="size-4" />
                {ownSandbox.name}
              </ButtonLink>
              <StatusBadge status={ownSandbox.status} />
            </div>
            <dl className="grid min-w-0 gap-2 text-xs sm:grid-cols-[auto_minmax(0,1fr)]">
              <dt className="text-muted-foreground">{s("image")}</dt>
              <dd
                title={ownSandbox.image ?? ""}
                className="min-w-0 truncate font-mono"
              >
                {ownSandbox.image?.replace(
                  /(@sha256:[a-f0-9]{12})[a-f0-9]+/gi,
                  "$1…",
                ) ?? "—"}
              </dd>
              <dt className="text-muted-foreground">{s("network")}</dt>
              <dd>
                {ownSandbox.network === "none"
                  ? s("networkNone")
                  : s("networkIsolated")}
              </dd>
            </dl>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t("ownSandboxMissing")}
          </p>
        )}
      </DialogField>
      <DialogField label={t("externalSandboxes")} dirty={dirty}>
        <div className="space-y-3">
          {attachments.map((attachment) => {
            const sandbox = externalSandboxes.find(
              (item) => item.id === attachment.sandboxId,
            );
            if (!sandbox) return null;
            const KindIcon =
              sandbox.kind === "connector"
                ? Cable
                : sandbox.kind === "ssh"
                  ? Server
                  : Box;
            return (
              <div
                key={sandbox.id}
                className="space-y-2 rounded-xl border border-border p-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <KindIcon className="size-4 shrink-0 text-muted-foreground" />
                  <ButtonLink
                    href={`/app/${slug}/sandboxes/${sandbox.id}`}
                    variant="ghost"
                    size="sm"
                    className="min-w-0 max-w-full"
                  >
                    <span className="truncate">{sandbox.name}</span>
                  </ButtonLink>
                  <span className="text-xs text-muted-foreground">
                    {s(kindLabel(sandbox.kind))}
                  </span>
                  <StatusBadge status={sandbox.status} />
                  <div className="ml-auto flex items-center gap-2">
                    <FormSelect
                      label={t("sandboxAccessFor", {
                        name: sandbox.name,
                      })}
                      value={attachment.access}
                      options={EXTERNAL_SANDBOX_ACCESS.map((access) => ({
                        value: access,
                        label: s(`access.${access}`),
                      }))}
                      onValueChange={(access) => {
                        setAttachments((current) =>
                          current.map((item) =>
                            item.sandboxId === sandbox.id
                              ? {
                                  ...item,
                                  access: access as ExternalSandboxAccess,
                                }
                              : item,
                          ),
                        );
                        onChange();
                      }}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={t("removeExternalSandbox", {
                        name: sandbox.name,
                      })}
                      onClick={() => {
                        setAttachments((current) =>
                          current.filter(
                            (item) => item.sandboxId !== sandbox.id,
                          ),
                        );
                        onChange();
                      }}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </div>
                {attachment.access === "full" ? (
                  <p className="text-xs text-amber-700 dark:text-amber-400">
                    {t("externalSandboxFullWarning")}
                  </p>
                ) : null}
              </div>
            );
          })}
          {attachments.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("noExternalSandboxes")}
            </p>
          ) : null}
          {attachments.length >= MAX_EXTERNAL_SANDBOXES ? (
            <p className="text-xs text-muted-foreground">
              {t("externalSandboxLimit", {
                count: MAX_EXTERNAL_SANDBOXES,
              })}
            </p>
          ) : externalSandboxes.some(
              (sandbox) =>
                !attachments.some((item) => item.sandboxId === sandbox.id),
            ) ? (
            <FormSelect
              label={t("addExternalSandbox")}
              value=""
              options={[
                {
                  value: "",
                  label: t("addExternalSandbox"),
                  disabled: true,
                },
                ...externalSandboxes
                  .filter(
                    (sandbox) =>
                      !attachments.some(
                        (item) => item.sandboxId === sandbox.id,
                      ),
                  )
                  .map((sandbox) => ({
                    value: sandbox.id,
                    label: `${sandbox.name} · ${s(kindLabel(sandbox.kind))}`,
                  })),
              ]}
              onValueChange={(sandboxId) => {
                setAttachments((current) =>
                  current.length < MAX_EXTERNAL_SANDBOXES &&
                  !current.some((item) => item.sandboxId === sandboxId)
                    ? [...current, { sandboxId, access: "read" }]
                    : current,
                );
                onChange();
              }}
            />
          ) : null}
          <ButtonLink
            href={`/app/${slug}/sandboxes?scope=external`}
            variant="secondary"
            size="sm"
          >
            {t("manageExternalSandboxes")}
          </ButtonLink>
        </div>
      </DialogField>
    </SettingsSection>
  );
}
