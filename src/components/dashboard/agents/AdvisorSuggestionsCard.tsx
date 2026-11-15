"use client";

import { useTranslations } from "next-intl";
import { AnimatedBadge } from "@/components/motion/animated-badge";
import { BouncyAccordion } from "@/components/motion/bouncy-accordion";
import type { AdvisorSuggestions } from "@/lib/agents/advisor";

const severityLabels = {
  info: "advisorInfo",
  warning: "advisorWarning",
  critical: "advisorCritical",
} as const;

const severityStyles = {
  info: "border-primary/30 bg-muted/50",
  warning: "border-amber-500/30 bg-amber-500/10",
  critical: "border-destructive/30 bg-destructive/10",
} as const;

export function AdvisorSuggestionsCard({
  advisory,
}: {
  advisory: AdvisorSuggestions;
}) {
  const t = useTranslations("console.agents");
  const severity = advisory.suggestions[0].severity;
  return (
    <div data-ui="advisor-suggestions" className="w-full min-w-0">
      <BouncyAccordion
        defaultValue={advisory.id}
        classNames={{
          item: severityStyles[severity],
          title: "whitespace-normal",
        }}
        items={[
          {
            id: advisory.id,
            title: (
              <span className="flex flex-wrap items-center gap-2">
                <span>{t("advisorSuggestions")}</span>
                <AnimatedBadge
                  status={severity === "critical" ? "danger" : severity}
                  size="sm"
                >
                  {t(severityLabels[severity])}
                </AnimatedBadge>
              </span>
            ),
            description: (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                  <span className="break-all" title={advisory.providerId}>
                    {advisory.model}
                  </span>
                  <span>
                    {t(
                      advisory.cadence === "final"
                        ? "advisorFinal"
                        : "advisorEachToolBatch",
                    )}
                  </span>
                  <span>{t("advisorAdviceOnly")}</span>
                </div>
                <ul className="m-0 list-none space-y-2 p-0">
                  {advisory.suggestions.map((suggestion) => (
                    <li
                      key={`${suggestion.severity}:${suggestion.message}`}
                      className={`space-y-2 rounded-lg border p-3 ${severityStyles[suggestion.severity]}`}
                    >
                      <AnimatedBadge
                        status={
                          suggestion.severity === "critical"
                            ? "danger"
                            : suggestion.severity
                        }
                        size="sm"
                      >
                        {t(severityLabels[suggestion.severity])}
                      </AnimatedBadge>
                      <p className="whitespace-pre-wrap break-words text-sm text-foreground [overflow-wrap:anywhere]">
                        {suggestion.message}
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            ),
          },
        ]}
      />
    </div>
  );
}
