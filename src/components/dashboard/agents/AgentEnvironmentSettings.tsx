"use client";

import { type Dispatch, type SetStateAction, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/motion/button/base";
import { Input } from "@/components/motion/input";
import { Switch } from "@/components/motion/switch";
import { BouncyAccordion } from "@/components/motion/bouncy-accordion";
import {
  createAgentEnvironmentCredentialAction,
  listAgentEnvironmentCredentialsAction,
  revokeAgentEnvironmentCredentialAction,
} from "@/lib/agents/environment-credential-actions";
import type { AgentRevisionConfig } from "@/lib/agents/revision-types";
import { DisplayError } from "../display-error";
import { DialogField } from "../dialog";
import { settingsTextareaClass } from "./SettingsSection";

type Credential = { id: string; name: string; revokedAt: Date | null };

/**
 * Sandbox environment of the next revision: credential store, secret
 * obfuscation and the environment definition. Credential actions save on their
 * own; the definition and obfuscation join the revision draft.
 */
export function AgentEnvironmentSettings({
  hidden,
  slug,
  agentId,
  canManageCredentials,
  pending,
  perform,
  environment,
  setEnvironment,
  onReviewStale,
  secretObfuscation,
  secretObfuscationDirty,
  onSecretObfuscationChange,
}: {
  hidden: boolean;
  slug: string;
  agentId: string;
  canManageCredentials: boolean;
  pending: boolean;
  /** Runs a settings operation with shared pending and failure feedback. */
  perform: (operation: () => Promise<void>) => Promise<void>;
  environment: string;
  setEnvironment: Dispatch<SetStateAction<string>>;
  onReviewStale: () => void;
  secretObfuscation: boolean;
  secretObfuscationDirty: boolean;
  onSecretObfuscationChange: (checked: boolean) => void;
}) {
  const t = useTranslations("console.agents");
  const r = useTranslations("console.agents.revisions");
  const common = useTranslations("common");
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [credentialsState, setCredentialsState] = useState<
    "idle" | "loading" | "loaded" | "failed"
  >("idle");
  const [credentialName, setCredentialName] = useState("");
  const [credentialValue, setCredentialValue] = useState("");
  const credentialsVisible = canManageCredentials && !hidden;
  function identity() {
    const data = new FormData();
    data.set("workspace", slug);
    data.set("agentId", agentId);
    return data;
  }
  // Loads once, the first time the sandbox page is shown to an owner.
  useEffect(() => {
    if (!credentialsVisible || credentialsState !== "idle") return;
    setCredentialsState("loading");
    const data = new FormData();
    data.set("workspace", slug);
    data.set("agentId", agentId);
    void listAgentEnvironmentCredentialsAction(data).then(
      (result) => {
        if (result.error) {
          setCredentialsState("failed");
          return;
        }
        setCredentials(result.credentials ?? []);
        setCredentialsState("loaded");
      },
      () => setCredentialsState("failed"),
    );
  }, [credentialsVisible, credentialsState, slug, agentId]);
  async function loadCredentials() {
    const result = await listAgentEnvironmentCredentialsAction(identity());
    if (result.error) throw new DisplayError(result.error);
    setCredentials(result.credentials ?? []);
    setCredentialsState("loaded");
  }
  const referencedCredentialIds = (() => {
    try {
      const definition = JSON.parse(
        environment,
      ) as AgentRevisionConfig["environment"];
      return new Set(
        definition.credentialReferences.map(
          (reference) => reference.credentialId,
        ),
      );
    } catch {
      return new Set<string>();
    }
  })();
  // A revoked credential can no longer be referenced; leaving it in the draft would fail the next save.
  function dropCredentialReference(credentialId: string) {
    setEnvironment((current) => {
      try {
        const definition = JSON.parse(
          current,
        ) as AgentRevisionConfig["environment"];
        if (
          !definition.credentialReferences.some(
            (reference) => reference.credentialId === credentialId,
          )
        )
          return current;
        definition.credentialReferences =
          definition.credentialReferences.filter(
            (reference) => reference.credentialId !== credentialId,
          );
        return JSON.stringify(definition, null, 2);
      } catch {
        return current;
      }
    });
  }
  return (
    <section hidden={hidden} className="space-y-5">
      {canManageCredentials ? (
        <DialogField label={r("credentials")}>
          <div className="space-y-3">
            {credentialsState === "failed" ? (
              <p role="alert" className="text-sm text-destructive">
                {r("credentialsLoadFailed")}
              </p>
            ) : credentialsState !== "loaded" ? (
              <p role="status" className="text-sm text-muted-foreground">
                {common("loading")}
              </p>
            ) : credentials.length ? (
              <ul className="m-0 list-none divide-y divide-border/60 overflow-hidden rounded-xl border border-border/60 p-0">
                {credentials.map((credential) => (
                  <li
                    key={credential.id}
                    className="flex min-w-0 items-center gap-3 px-4 py-2"
                  >
                    <span
                      className={`min-w-0 flex-1 truncate font-mono text-sm ${credential.revokedAt ? "text-muted-foreground line-through" : ""}`}
                    >
                      {credential.name}
                    </span>
                    {credential.revokedAt ? (
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {r("credentialRevoked")}
                      </span>
                    ) : (
                      <>
                        {referencedCredentialIds.has(credential.id) ? (
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {r("credentialReferenced")}
                          </span>
                        ) : (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={pending || !environment.trim()}
                            onClick={() =>
                              void perform(async () => {
                                const definition = JSON.parse(
                                  environment,
                                ) as AgentRevisionConfig["environment"];
                                definition.credentialReferences = [
                                  ...definition.credentialReferences.filter(
                                    (reference) =>
                                      reference.name !== credential.name,
                                  ),
                                  {
                                    name: credential.name,
                                    credentialId: credential.id,
                                  },
                                ];
                                setEnvironment(
                                  JSON.stringify(definition, null, 2),
                                );
                                onReviewStale();
                              })
                            }
                          >
                            {r("credentialRef")}
                          </Button>
                        )}
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={pending}
                          onClick={() =>
                            void perform(async () => {
                              const data = identity();
                              data.set("credentialId", credential.id);
                              const result =
                                await revokeAgentEnvironmentCredentialAction(
                                  data,
                                );
                              if ("error" in result)
                                throw new DisplayError(result.error);
                              dropCredentialReference(credential.id);
                              await loadCredentials();
                              onReviewStale();
                            })
                          }
                        >
                          {r("revokeCredential")}
                        </Button>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">
                {r("noCredentials")}
              </p>
            )}
            <div className="flex flex-wrap items-start gap-2">
              <Input
                aria-label={r("credentialName")}
                placeholder={r("credentialName")}
                value={credentialName}
                onChange={setCredentialName}
                className="min-w-40 flex-1"
                classNames={{ input: "font-mono" }}
              />
              <Input
                aria-label={r("credentialValue")}
                placeholder={r("credentialValue")}
                type="password"
                value={credentialValue}
                onChange={setCredentialValue}
                className="min-w-40 flex-1"
              />
              <Button
                type="button"
                variant="secondary"
                disabled={pending || !credentialName || !credentialValue}
                onClick={() =>
                  void perform(async () => {
                    const data = identity();
                    data.set("name", credentialName);
                    data.set("value", credentialValue);
                    const result =
                      await createAgentEnvironmentCredentialAction(data);
                    if ("error" in result) throw new DisplayError(result.error);
                    setCredentialName("");
                    setCredentialValue("");
                    await loadCredentials();
                  })
                }
              >
                {r("createCredential")}
              </Button>
            </div>
          </div>
        </DialogField>
      ) : null}
      <DialogField
        label={t("secretObfuscation")}
        description={t("secretObfuscationDescription")}
        dirty={secretObfuscationDirty}
        layout="row"
      >
        <Switch
          checked={secretObfuscation}
          ariaLabel={t("secretObfuscation")}
          disabled={pending}
          onCheckedChange={onSecretObfuscationChange}
        />
      </DialogField>
      <BouncyAccordion
        items={[
          {
            id: "environment",
            title: r("environment"),
            description: (
              <div className="space-y-3 px-3 pb-3">
                <p className="text-xs text-muted-foreground">
                  {r("environmentHelp")}
                </p>
                <textarea
                  aria-label={r("environment")}
                  rows={14}
                  value={environment}
                  onChange={(event) => {
                    setEnvironment(event.target.value);
                    onReviewStale();
                  }}
                  className={`${settingsTextareaClass} font-mono`}
                />
              </div>
            ),
          },
        ]}
      />
    </section>
  );
}
