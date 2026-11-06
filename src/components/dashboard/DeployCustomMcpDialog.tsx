"use client";
import { BouncyAccordion } from "@/components/motion/bouncy-accordion";
import {
  DialogHeader,
  DialogBody,
  DialogFooter,
  DialogCancel,
  DialogField,
} from "@/components/dashboard/dialog";

import { CenterMorphModal } from "@/components/motion/center-morph-modal";
import { CenterMorphModalTrigger } from "@/components/motion/center-morph-modal";
import { CenterMorphModalContent } from "@/components/motion/center-morph-modal";

import { Button } from "@/components/motion/button";

import { useTranslations } from "next-intl";
import {
  useActionState,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { Plus, AlertTriangle, Plug } from "lucide-react";
import { deployCustomServerAction } from "@/lib/workspace/actions";
import {
  mcpConfigErrorDetail,
  parseMcpJsonConfig,
} from "@/lib/workspace/custom-mcp";
import { McpNetworkModeControl } from "./McpNetworkModeControl";
import {
  RuntimeFileDraftsInput,
  runtimeFilePathKey,
  type RuntimeFileDraft,
} from "./RuntimeFileDraftsInput";
import { SubmitButton } from "./SubmitButton";
import { RemoteMcpTransportNotice } from "./RemoteMcpTransportNotice";
import { McpHttpConsent } from "./McpHttpConsent";

const JSON_CONFIG_EXAMPLES = {
  npxConfig: `{
  "mcpServers": {
    "ssh-mcp-server": {
      "command": "npx",
      "args": [
        "-y",
        "@fangjunjie/ssh-mcp-server",
        "--config-file", "ssh-config.json"
      ]
    }
  }
}`,
  npxGit: `{
  "mcpServers": {
    "git-mcp": {
      "command": "npx",
      "args": [
        "-y",
        "git+https://git.example.com/group/repository.git#v1.0.0",
        "--config-file", "mcp-config.json"
      ]
    }
  }
}`,
  uvxGit: `{
  "mcpServers": {
    "uvx-git-mcp": {
      "command": "uvx",
      "args": [
        "--from",
        "git+https://git.example.com/group/repository.git@v1.0.0",
        "repository-mcp",
        "--config", "mcp-config.toml"
      ]
    }
  }
}`,
  uv: `{
  "mcpServers": {
    "uv-mcp": {
      "command": "uv",
      "args": [
        "run",
        "--with", "your-mcp-package",
        "your-mcp-command",
        "--config", "mcp-config.toml"
      ]
    }
  }
}`,
  docker: `{
  "mcpServers": {
    "container-mcp": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "registry.example.com/organization/mcp-server:latest",
        "--config", "/toolplane/config/mcp-config.json"
      ]
    }
  }
}`,
  remoteHttp: `{
  "mcpServers": {
    "remote-mcp": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "Authorization": "Bearer <TOKEN>"
      }
    }
  }
}`,
} as const;

export function DeployCustomMcpDialog({
  slug,
  allowHttp,
  defaultOpen = false,
  inline = false,
}: {
  slug: string;
  allowHttp: boolean;
  defaultOpen?: boolean;
  inline?: boolean;
}) {
  const t = useTranslations("console.mcp");
  // `jsonGitHint` includes URL placeholders such as `<host>`. Read it as raw
  // text so next-intl does not interpret those placeholders as rich-text tags.
  const jsonGitHint =
    typeof t.raw === "function"
      ? String(t.raw("jsonGitHint"))
      : t("jsonGitHint");
  const [open, setOpen] = useState(defaultOpen);
  const [config, setConfig] = useState("");
  const [configError, setConfigError] = useState<string | null>(null);
  const [runtimeFiles, setRuntimeFiles] = useState<RuntimeFileDraft[]>([]);
  const [runtimeFilesError, setRuntimeFilesError] = useState<string | null>(
    null,
  );
  const [network, setNetwork] = useState<"isolated" | "none">("isolated");
  const [networkTouched, setNetworkTouched] = useState(false);
  const [allowUnsafeHttp, setAllowUnsafeHttp] = useState(false);
  const [creationError, createAction] = useActionState<
    "connectionCreateFailed" | "mcpVersionResolutionFailed" | null,
    FormData
  >(async (_previous, form) => {
    const result = await deployCustomServerAction(form);
    // Creation redirects on success; a returned action did not create a usable connection.
    return result?.error ?? "connectionCreateFailed";
  }, null);

  const configRef = useRef<HTMLTextAreaElement>(null);

  const parsedConfig = useMemo(() => {
    if (!config.trim()) return null;
    try {
      const parsed = parseMcpJsonConfig(config, undefined, {
        allowUnsafeHttp: true,
      });
      return {
        name: parsed.name,
        source: parsed.source,
        ref: parsed.ref,
        command:
          parsed.installCfg && "command" in parsed.installCfg
            ? parsed.installCfg.command
            : null,
      };
    } catch {
      return null;
    }
  }, [config]);
  const configName = parsedConfig?.name ?? "";
  const configCommand = parsedConfig?.command;
  const configIsRemote = parsedConfig?.source === "remote";

  const setJsonConfig = (nextConfig: string) => {
    setConfig(nextConfig);
    setConfigError(null);
    if (!networkTouched) {
      try {
        const parsed = parseMcpJsonConfig(nextConfig);
        setNetwork(
          parsed.installCfg &&
            "network" in parsed.installCfg &&
            parsed.installCfg.network === "none"
            ? "none"
            : "isolated",
        );
      } catch {
        // Example JSON is valid, but preserve the current selection defensively.
      }
    }
  };

  const validateBeforeSubmit = (event: FormEvent<HTMLFormElement>) => {
    try {
      parseMcpJsonConfig(config, undefined, { allowUnsafeHttp, allowHttp });
      setConfigError(null);
    } catch (error) {
      event.preventDefault();
      setConfigError(mcpConfigErrorDetail(error) ?? t("invalidJsonConfig"));
      return;
    }
    const runtimeFileKeys = new Set<string>();
    const invalidRuntimeFile = runtimeFiles.some(({ path, content }) => {
      const value = path;
      const parts = value.split("/");
      const invalidPath =
        !value ||
        value !== value.trim() ||
        value.startsWith("/") ||
        value.includes("\\") ||
        /[^\x20-\uFFFF]|\x7f/.test(value) ||
        parts.some((part) => !part || part === "." || part === "..");
      if (invalidPath || content.includes("\0")) return true;

      const key = runtimeFilePathKey(value);
      if (!key || runtimeFileKeys.has(key)) return true;
      runtimeFileKeys.add(key);
      return false;
    });
    if (invalidRuntimeFile) {
      event.preventDefault();
      setRuntimeFilesError(t("invalidRuntimeFile"));
    } else {
      setRuntimeFilesError(null);
    }
  };

  const content = (
    <>
      <DialogHeader
        title={t("deployCustomMcp")}
        icon={<Plug className="size-4" />}
        description={
          <span id="deploy-custom-mcp-description">
            {t("jsonSingleServerHint")}
          </span>
        }
      />

      <form
        action={createAction}
        onSubmit={validateBeforeSubmit}
        className="flex min-h-0 flex-1 flex-col"
      >
        <input type="hidden" name="workspace" value={slug} />
        <input type="hidden" name="source" value="config" />
        <input
          type="hidden"
          name="runtimeFiles"
          value={JSON.stringify(configIsRemote ? [] : runtimeFiles)}
        />

        <DialogBody>
          <div className="flex gap-2.5 rounded-lg bg-muted px-3 py-2.5 text-xs leading-5 text-foreground">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span>
              {t(
                "mcpCanAccessYourDataAndExecuteArbitraryCodeOnlyInstallSourcesYouTrust",
              )}
            </span>
          </div>

          <DialogField
            label={t("jsonConfig")}
            htmlFor="config"
            description={t("jsonCommandHint")}
            dirty={config !== ""}
          >
            <div className="space-y-3">
              <textarea
                // biome-ignore lint/a11y/noAutofocus: Modal opening focuses its primary config field; removing this changes keyboard focus behavior.
                autoFocus={!inline}
                ref={configRef}
                id="config"
                name="config"
                required
                value={config}
                onChange={(event) => setJsonConfig(event.target.value)}
                placeholder={JSON_CONFIG_EXAMPLES.npxConfig}
                spellCheck={false}
                aria-invalid={Boolean(configError)}
                aria-describedby={configError ? "config-error" : undefined}
                className="min-h-52 w-full resize-y rounded-lg border border-border bg-muted/35 p-3 font-mono text-sm leading-6 outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>
          </DialogField>
          <div className="space-y-3">
            {configName ? (
              <p className="text-xs text-muted-foreground">
                {t("serverColumn")}:{" "}
                <span className="font-medium text-foreground">
                  {configName}
                </span>
              </p>
            ) : null}
            {configIsRemote ? (
              <RemoteMcpTransportNotice url={parsedConfig?.ref} showHelp />
            ) : null}
            {!allowHttp ? (
              <DialogField label={null} dirty={allowUnsafeHttp}>
                <McpHttpConsent onChange={setAllowUnsafeHttp} />
              </DialogField>
            ) : null}
            {configError ? (
              <p
                id="config-error"
                role="alert"
                className="text-xs text-destructive dark:text-destructive"
              >
                {configError}
              </p>
            ) : null}
            {creationError ? (
              <p role="alert" className="text-sm text-destructive">
                {t(creationError)}
              </p>
            ) : null}
            <BouncyAccordion
              items={[
                {
                  id: "details",
                  title: <>{t("jsonExamples")}</>,
                  description: (
                    <>
                      <div className="space-y-3 border-t border-border px-3 py-3">
                        <p className="text-xs leading-5 text-muted-foreground">
                          {t("jsonExamplesHint")}
                        </p>
                        {(
                          [
                            ["npxConfig", "jsonExampleNpxConfig"],
                            ["npxGit", "jsonExampleNpxGit"],
                            ["uvxGit", "jsonExampleUvxGit"],
                            ["uv", "jsonExampleUv"],
                            ["docker", "jsonExampleDocker"],
                            ["remoteHttp", "jsonExampleRemoteHttp"],
                          ] as const
                        ).map(([key, label]) => (
                          <div
                            key={key}
                            className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-card px-3 py-2"
                          >
                            <span className="text-xs font-medium text-foreground">
                              {t(label)}
                            </span>
                            <Button
                              type="button"
                              onClick={() =>
                                setJsonConfig(JSON_CONFIG_EXAMPLES[key])
                              }
                              variant="secondary"
                              size="sm"
                            >
                              {t("useJsonExample")}
                            </Button>
                          </div>
                        ))}
                        <p className="text-xs leading-5 text-muted-foreground">
                          {jsonGitHint}
                        </p>
                      </div>
                    </>
                  ),
                },
              ]}
            />
          </div>

          {!configIsRemote ? (
            <>
              <DialogField
                label={t("runtimeFilesOptional")}
                dirty={runtimeFiles.length > 0}
              >
                <BouncyAccordion
                  items={[
                    {
                      id: "details",
                      title: <>{t("runtimeFilesOptional")}</>,
                      description: (
                        <>
                          <div className="border-t border-border p-3">
                            <p className="mb-3 text-xs leading-5 text-muted-foreground">
                              {t("runtimeFilesOptionalHint")}
                            </p>
                            <RuntimeFileDraftsInput
                              value={runtimeFiles}
                              relativePathArgumentsWork={
                                configCommand !== "docker"
                              }
                              onChange={(files) => {
                                setRuntimeFiles(files);
                                setRuntimeFilesError(null);
                              }}
                            />
                          </div>
                        </>
                      ),
                    },
                  ]}
                />
                {runtimeFilesError ? (
                  <p
                    className="text-xs text-destructive dark:text-destructive"
                    role="alert"
                  >
                    {runtimeFilesError}
                  </p>
                ) : null}
              </DialogField>

              <DialogField
                label={t("networkMode")}
                dirty={network !== "isolated"}
              >
                <BouncyAccordion
                  items={[
                    {
                      id: "network",
                      title: `${t("networkMode")}: ${network === "none" ? t("networkNone") : t("networkIsolated")}`,
                      description: (
                        <McpNetworkModeControl
                          value={network}
                          onChange={(value) => {
                            setNetwork(value);
                            setNetworkTouched(true);
                          }}
                          warnAboutPackageInstall={configCommand !== "docker"}
                        />
                      ),
                    },
                  ]}
                />
              </DialogField>
            </>
          ) : null}
        </DialogBody>

        <DialogFooter cancel={!inline ? <DialogCancel /> : undefined}>
          <SubmitButton
            flash={false}
            error={Boolean(creationError)}
            pendingLabel={t("deploying")}
            variant="primary"
            size="md"
          >
            {t("deploy")}
          </SubmitButton>
        </DialogFooter>
      </form>
    </>
  );
  if (inline) return content;

  return (
    <CenterMorphModal open={open} onOpenChange={setOpen}>
      <CenterMorphModalTrigger>
        <Button type="button" variant="primary" size="md">
          <Plus className="size-4" />
          {t("addCustomMcp")}
        </Button>
      </CenterMorphModalTrigger>

      <CenterMorphModalContent
        ariaLabel={t("deployCustomMcp")}
        ariaDescribedBy="deploy-custom-mcp-description"
        closeButtonLabel={t("cancel")}
        className="flex max-h-[calc(100dvh-4rem)] w-full max-w-2xl flex-col"
      >
        {content}
      </CenterMorphModalContent>
    </CenterMorphModal>
  );
}
