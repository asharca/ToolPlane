"use client";

import { useTranslations } from "next-intl";
import { Input } from "@/components/motion/input";
import { Switch } from "@/components/motion/switch";
import { FormSelect } from "@/components/ui/FormSelect";
import {
  ModelPicker,
  ModelPickerTrigger,
  type ModelProviderOption,
} from "@/components/dashboard/models/ModelPicker";
import {
  AGENT_STEP_BOUNDS,
  AGENT_TASK_TIMEOUT_BOUNDS,
} from "@/lib/agents/constants";
import type { AgentAdvisor } from "@/lib/agents/revision-types";
import { DialogField } from "../dialog";
import { SettingsSection } from "./SettingsSection";

/** Step and time limits plus the reviewing advisor model. */
export function AgentExecutionSettings({
  hidden,
  formId,
  slug,
  pending,
  providers,
  compatibleProviders,
  primary,
  steps,
  setSteps,
  timeoutMinutes,
  setTimeoutMinutes,
  defaultTaskTimeoutSeconds,
  advisor,
  setAdvisor,
  dirty,
  onChange,
}: {
  hidden: boolean;
  formId: string;
  slug: string;
  pending: boolean;
  /** Every provider, for naming the stored advisor selection. */
  providers: ReadonlyArray<{ id: string; name: string }>;
  /** Providers this runtime can use. */
  compatibleProviders: ModelProviderOption[];
  /** The Agent's primary model, the advisor's initial model. */
  primary: { providerId: string; model: string };
  steps: string;
  setSteps: (value: string) => void;
  timeoutMinutes: string;
  setTimeoutMinutes: (value: string) => void;
  defaultTaskTimeoutSeconds: number;
  advisor: AgentAdvisor | null;
  setAdvisor: (advisor: AgentAdvisor | null) => void;
  dirty: { maxSteps: boolean; taskTimeout: boolean; advisor: boolean };
  onChange: () => void;
}) {
  const t = useTranslations("console.agents");
  return (
    <SettingsSection
      id="execution"
      title={t("executionSettings")}
      className="space-y-4"
      hidden={hidden}
    >
      <DialogField
        label={t("maxToolSteps")}
        htmlFor={`${formId}-steps`}
        dirty={dirty.maxSteps}
        layout="row"
      >
        <Input
          id={`${formId}-steps`}
          aria-label={t("maxToolSteps")}
          name="maxSteps"
          type="number"
          min={AGENT_STEP_BOUNDS.min}
          max={AGENT_STEP_BOUNDS.max}
          value={steps}
          onChange={setSteps}
          className="w-24"
        />
      </DialogField>
      <DialogField
        label={t("taskTimeout")}
        description={t("taskTimeoutDescription")}
        htmlFor={`${formId}-task-timeout`}
        dirty={dirty.taskTimeout}
        layout="row"
      >
        <Input
          id={`${formId}-task-timeout`}
          aria-label={t("taskTimeout")}
          name="taskTimeoutMinutes"
          type="number"
          step={1}
          min={AGENT_TASK_TIMEOUT_BOUNDS.min / 60}
          max={AGENT_TASK_TIMEOUT_BOUNDS.max / 60}
          placeholder={String(Math.round(defaultTaskTimeoutSeconds / 60))}
          value={timeoutMinutes}
          onChange={setTimeoutMinutes}
          className="w-24"
        />
      </DialogField>
      <DialogField label={t("advisor")} dirty={dirty.advisor} layout="row">
        <Switch
          checked={advisor !== null}
          disabled={pending}
          ariaLabel={t("advisorEnabled")}
          onCheckedChange={(enabled) => {
            setAdvisor(
              enabled
                ? {
                    ...primary,
                    cadence: "final",
                    minSeverity: "warning",
                  }
                : null,
            );
            onChange();
          }}
        />
      </DialogField>
      {advisor ? (
        <div className="space-y-4">
          <DialogField label={t("advisorModel")} layout="row">
            <ModelPicker
              className="flex w-72 max-w-full"
              pending={pending}
              providers={compatibleProviders}
              value={advisor.providerId && advisor.model ? advisor : null}
              onSelect={(selection) => {
                setAdvisor({ ...advisor, ...selection });
                onChange();
              }}
              onConfigure={() =>
                window.location.assign(
                  `/app/${encodeURIComponent(slug)}/providers`,
                )
              }
              trigger={
                <ModelPickerTrigger
                  label={advisor.model || t("selectModel")}
                  placeholder={!advisor.model}
                  provider={
                    providers.find((item) => item.id === advisor.providerId)
                      ?.name
                  }
                  aria-label={t("advisorModel")}
                  disabled={pending}
                />
              }
            />
          </DialogField>
          <DialogField
            label={t("advisorCadence")}
            htmlFor={`${formId}-advisor-cadence`}
            layout="row"
          >
            <FormSelect
              className="w-40"
              id={`${formId}-advisor-cadence`}
              label={t("advisorCadence")}
              value={advisor.cadence}
              disabled={pending}
              options={[
                {
                  value: "each_tool_batch",
                  label: t("advisorEachToolBatch"),
                },
                { value: "final", label: t("advisorFinal") },
              ]}
              onValueChange={(value) => {
                if (value !== "each_tool_batch" && value !== "final") return;
                setAdvisor({ ...advisor, cadence: value });
                onChange();
              }}
            />
          </DialogField>
          <DialogField
            label={t("advisorMinSeverity")}
            htmlFor={`${formId}-advisor-severity`}
            layout="row"
          >
            <FormSelect
              className="w-40"
              id={`${formId}-advisor-severity`}
              label={t("advisorMinSeverity")}
              value={advisor.minSeverity}
              disabled={pending}
              options={[
                { value: "info", label: t("advisorInfo") },
                { value: "warning", label: t("advisorWarning") },
                {
                  value: "critical",
                  label: t("advisorCritical"),
                },
              ]}
              onValueChange={(value) => {
                if (
                  value !== "info" &&
                  value !== "warning" &&
                  value !== "critical"
                )
                  return;
                setAdvisor({ ...advisor, minSeverity: value });
                onChange();
              }}
            />
          </DialogField>
        </div>
      ) : null}
    </SettingsSection>
  );
}
