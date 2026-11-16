"use client";

import { useId, useState } from "react";
import { useTranslations } from "next-intl";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/motion/button";
import { Input } from "@/components/motion/input";
import { FormSelect } from "@/components/ui/FormSelect";
import type { ToolApprovalPolicy } from "@/lib/agents/tool-approval-policy";
import { DialogField } from "../dialog";

export function ToolApprovalSettings({
  value,
  disabled,
  dirty,
  onChange,
}: {
  value: ToolApprovalPolicy;
  disabled: boolean;
  dirty: boolean;
  onChange: (value: ToolApprovalPolicy) => void;
}) {
  const t = useTranslations("console.toolApproval");
  const id = useId();
  const [toolName, setToolName] = useState("");
  const overrides = value.overrides ?? {};
  const name = toolName.trim();
  return (
    <div className="space-y-5">
      <DialogField label={t("mode")} htmlFor={`${id}-mode`} dirty={dirty}>
        <FormSelect
          id={`${id}-mode`}
          label={t("mode")}
          value={value.mode}
          disabled={disabled}
          options={(["off", "write", "exec", "all"] as const).map((mode) => ({
            value: mode,
            label: t(mode),
          }))}
          onValueChange={(mode) =>
            onChange({ ...value, mode: mode as ToolApprovalPolicy["mode"] })
          }
        />
      </DialogField>
      <DialogField label={t("overrides")} dirty={dirty}>
        <div className="space-y-3">
          {Object.entries(overrides).map(([tool, decision]) => (
            <div key={tool} className="flex flex-wrap items-center gap-2">
              <code className="min-w-0 flex-1 break-all text-sm">{tool}</code>
              <FormSelect
                label={t("overrideFor", { tool })}
                value={decision}
                disabled={disabled}
                options={(["ask", "allow", "deny"] as const).map((action) => ({
                  value: action,
                  label: t(action),
                }))}
                onValueChange={(action) =>
                  onChange({
                    ...value,
                    overrides: {
                      ...overrides,
                      [tool]: action as "ask" | "allow" | "deny",
                    },
                  })
                }
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled={disabled}
                aria-label={t("removeOverride", { tool })}
                onClick={() =>
                  onChange({
                    ...value,
                    overrides: Object.fromEntries(
                      Object.entries(overrides).filter(([key]) => key !== tool),
                    ),
                  })
                }
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-2">
            <Input
              aria-label={t("toolName")}
              placeholder={t("toolName")}
              value={toolName}
              onChange={setToolName}
              maxLength={512}
              disabled={disabled}
              className="min-w-0 flex-1"
              onKeyDown={(event) => {
                if (event.key === "Enter") event.preventDefault();
              }}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled || !name || Object.hasOwn(overrides, name)}
              onClick={() => {
                onChange({
                  ...value,
                  overrides: { ...overrides, [name]: "ask" },
                });
                setToolName("");
              }}
            >
              {t("addOverride")}
            </Button>
          </div>
        </div>
      </DialogField>
      <p className="text-xs text-muted-foreground">{t("help")}</p>
    </div>
  );
}
