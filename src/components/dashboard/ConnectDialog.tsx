"use client";
import {
  CenterMorphModal,
  CenterMorphModalTrigger,
  CenterMorphModalContent,
} from "@/components/motion/center-morph-modal";
import { Button } from "@/components/motion/button";
import {
  DialogBody,
  DialogCancel,
  DialogFooter,
  DialogHeader,
} from "@/components/dashboard/dialog";
import { CopyButton } from "./CopyButton";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { ArrowRight } from "lucide-react";

type Client = {
  id: string;
  label: string;
  labelKey?: "connectionUrl";
  howToKey:
    | "runInTerminal"
    | "addToClaudeDesktopConfig"
    | "addToCursorConfig"
    | "addToVsCodeConfig"
    | "addToCodexConfig"
    | "addToOpenCodeConfig"
    | "addToWindsurfConfig"
    | "addToClineConfig"
    | "addToGeminiConfig"
    | "useUrlInAnyMcpClient";
  snippet: (key: string, endpoint: string) => string;
};

function jsonConfig(key: string, endpoint: string): string {
  return `{
  "mcpServers": {
    "${key}": {
      "type": "http",
      "url": "${endpoint}",
      "headers": {
        "Authorization": "Bearer <API_TOKEN>"
      }
    }
  }
}`;
}

const CLIENTS: Client[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    howToKey: "runInTerminal",
    snippet: (key, endpoint) =>
      `claude mcp add --transport http "${key}" "${endpoint}" \\\n  --header "Authorization: Bearer <API_TOKEN>"`,
  },
  {
    id: "claude-desktop",
    label: "Claude Desktop",
    howToKey: "addToClaudeDesktopConfig",
    snippet: jsonConfig,
  },
  {
    id: "cursor",
    label: "Cursor",
    howToKey: "addToCursorConfig",
    snippet: jsonConfig,
  },
  {
    id: "vscode",
    label: "VS Code",
    howToKey: "addToVsCodeConfig",
    snippet: (key, endpoint) =>
      `{
  "servers": {
    "${key}": {
      "type": "http",
      "url": "${endpoint}",
      "headers": {
        "Authorization": "Bearer <API_TOKEN>"
      }
    }
  }
}`,
  },
  {
    id: "codex",
    label: "Codex CLI",
    howToKey: "addToCodexConfig",
    snippet: (key, endpoint) =>
      [
        `[mcp_servers.${key}]`,
        `url = "${endpoint}"`,
        'http_headers = { Authorization = "Bearer <API_TOKEN>" }',
      ].join("\n"),
  },
  {
    id: "opencode",
    label: "opencode",
    howToKey: "addToOpenCodeConfig",
    snippet: (key, endpoint) =>
      [
        "{",
        '  "$schema": "https://opencode.ai/config.json",',
        '  "mcp": {',
        `    "${key}": {`,
        '      "type": "remote",',
        `      "url": "${endpoint}",`,
        '      "enabled": true,',
        '      "oauth": false,',
        '      "headers": { "Authorization": "Bearer <API_TOKEN>" }',
        "    }",
        "  }",
        "}",
      ].join("\n"),
  },
  {
    id: "windsurf",
    label: "Windsurf",
    howToKey: "addToWindsurfConfig",
    snippet: jsonConfig,
  },
  {
    id: "cline",
    label: "Cline",
    howToKey: "addToClineConfig",
    snippet: jsonConfig,
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    howToKey: "addToGeminiConfig",
    snippet: jsonConfig,
  },
  {
    id: "url",
    label: "Connection URL",
    labelKey: "connectionUrl",
    howToKey: "useUrlInAnyMcpClient",
    snippet: (_key, endpoint) => endpoint,
  },
];

export function ConnectDialog({
  endpoint,
  name,
  label,
  variant = "banner",
}: {
  endpoint: string;
  name: string;
  label?: string;
  variant?: "banner" | "outline";
}) {
  const t = useTranslations("console.common");
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Client>(CLIENTS[0]);

  const key =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "mcp";
  const selectedLabel = selected.labelKey
    ? t(selected.labelKey)
    : selected.label;
  const snippetText = selected.snippet(key, endpoint);

  return (
    <CenterMorphModal open={open} onOpenChange={setOpen}>
      <CenterMorphModalTrigger>
        <Button
          type="button"
          variant={variant === "banner" ? "primary" : "secondary"}
          size="md"
        >
          {variant === "banner" ? <ArrowRight className="size-3.5" /> : null}
          {label ?? t("connectWith")}
        </Button>
      </CenterMorphModalTrigger>

      <CenterMorphModalContent
        ariaLabel={t("installServer")}
        closeButtonLabel={t("close")}
        className="flex max-h-[calc(100dvh-2rem)] w-full max-w-2xl flex-col"
      >
        <DialogHeader title={t("installServer")} />
        <DialogBody className="pt-0">
          <div className="grid gap-4 sm:grid-cols-[12rem_minmax(0,1fr)]">
            <nav
              aria-label={t("connectWith")}
              className="flex flex-wrap gap-1.5 sm:flex-col sm:gap-1"
            >
              {CLIENTS.map((c) => {
                const active = selected.id === c.id;
                return (
                  <Button
                    key={c.id}
                    type="button"
                    onClick={() => setSelected(c)}
                    aria-pressed={active}
                    variant={active ? "secondary" : "ghost"}
                    size="sm"
                    className="justify-start text-left"
                  >
                    {c.labelKey ? t(c.labelKey) : c.label}
                  </Button>
                );
              })}
            </nav>
            <div className="min-w-0 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-medium text-foreground">
                    {selectedLabel}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t(selected.howToKey)}
                  </p>
                </div>
                <CopyButton text={snippetText} label={t("copySnippet")} />
              </div>
              <pre className="overflow-x-auto rounded-xl border border-border bg-muted/50 p-3 font-mono text-xs leading-5 text-foreground">
                {snippetText}
              </pre>
            </div>
          </div>
        </DialogBody>
        <DialogFooter cancel={<DialogCancel />} />
      </CenterMorphModalContent>
    </CenterMorphModal>
  );
}
