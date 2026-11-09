"use client";

import { useActionState, useEffect, useId, useState } from "react";
import { useTranslations } from "next-intl";
import { CopyPlus } from "lucide-react";
import { Input } from "@/components/motion/input";
import { FormCheckbox } from "@/components/ui/FormCheckbox";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import { DialogField } from "@/components/dashboard/dialog";
import { notify } from "@/components/dashboard/Toaster";
import { cloneAgentAction } from "@/lib/agents/actions";

export function AgentClonePanel({
  slug,
  agentId,
  agentName,
  mcpCount,
  skillCount,
  piPackageCount,
}: {
  slug: string;
  agentId: string;
  agentName: string;
  mcpCount: number;
  skillCount: number;
  piPackageCount: number;
}) {
  const t = useTranslations("console.agents");
  const [state, action] = useActionState(cloneAgentAction, {});
  const [name, setName] = useState(() =>
    String(t("agentCopyName", { name: agentName })),
  );
  const nameId = useId();
  const options = [
    { name: "copyMcp", label: t("mcp"), count: mcpCount },
    { name: "copySkills", label: t("skills"), count: skillCount },
    { name: "copyPiPackages", label: t("piPackages"), count: piPackageCount },
  ];
  const [checked, setChecked] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(options.map((o) => [o.name, o.count > 0])),
  );

  useEffect(() => {
    if (state.error) notify(state.error, { severity: "error" });
  }, [state]);

  return (
    <form action={action} className="max-w-2xl space-y-5 px-6 py-5">
      <input type="hidden" name="workspace" value={slug} />
      <input type="hidden" name="agentId" value={agentId} />
      <p className="text-sm text-muted-foreground">
        {t("cloneDraftDescription")}
      </p>
      <DialogField label={t("cloneName")} htmlFor={nameId}>
        <Input
          id={nameId}
          name="cloneName"
          maxLength={60}
          value={name}
          onChange={setName}
          className="w-full"
        />
      </DialogField>
      <DialogField label={t("cloneScope")}>
        <div className="flex flex-col items-start gap-3">
          {options.map((option) => (
            <FormCheckbox
              key={option.name}
              name={option.name}
              label={`${option.label} (${option.count})`}
              disabled={option.count === 0}
              checked={checked[option.name] ?? false}
              onCheckedChange={(value) =>
                setChecked((prev) => ({ ...prev, [option.name]: value }))
              }
            />
          ))}
          <FormCheckbox
            name="copyConversations"
            label={t("copyReadOnlyHistory")}
            checked={checked.copyConversations ?? false}
            onCheckedChange={(value) =>
              setChecked((prev) => ({ ...prev, copyConversations: value }))
            }
          />
        </div>
      </DialogField>
      <SubmitButton size="md" pendingLabel={t("cloning")} flash={false}>
        <CopyPlus className="size-4" />
        {t("cloneAgent")}
      </SubmitButton>
    </form>
  );
}
