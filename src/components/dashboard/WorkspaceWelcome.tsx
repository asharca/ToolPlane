"use client";
import { ButtonLink, Button } from "@/components/motion/button";

import { useState } from "react";

import { Check, X } from "lucide-react";
import { useTranslations } from "next-intl";

export function WorkspaceWelcome({
  slug,
  name,
  isOwner,
  hasProviders,
  hasAgents,
  hasConversations,
}: {
  slug: string;
  name: string;
  isOwner: boolean;
  hasProviders: boolean;
  hasAgents: boolean;
  hasConversations: boolean;
}) {
  const t = useTranslations("console.workspaces");
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  const base = `/app/${encodeURIComponent(slug)}`;
  const steps = [
    {
      label: t("addModelProvider"),
      href: `${base}/providers`,
      completed: hasProviders,
    },
    {
      label: t("createAgent"),
      href: `${base}/agents?create=1&returnTo=${encodeURIComponent(`${base}/work?welcome=1`)}`,
      completed: hasAgents,
    },
    {
      label: t("startChat"),
      href: `${base}/work`,
      completed: hasConversations,
    },
  ];
  const currentStep = steps.findIndex((step) => !step.completed);
  return (
    <section
      aria-label={t("welcome", { name })}
      className="relative mx-4 my-3 shrink-0 rounded-xl border border-border bg-background p-4 pr-10"
    >
      <h2 className="break-words text-sm font-semibold">
        {t("welcome", { name })}
      </h2>
      {isOwner ? (
        <ol className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2">
          {steps.map((step, index) => {
            const current = index === currentStep;
            return (
              <li
                key={step.label}
                aria-current={current ? "step" : undefined}
                className="flex min-w-0 items-center gap-2"
              >
                <span
                  aria-hidden="true"
                  className="grid size-5 shrink-0 place-items-center rounded-full border border-border-strong text-[11px] text-muted-foreground"
                >
                  {step.completed ? <Check className="size-3" /> : index + 1}
                </span>
                <span className="sr-only">
                  {t(
                    step.completed
                      ? "stepCompleted"
                      : current
                        ? "stepCurrent"
                        : "stepNotStarted",
                  )}
                </span>
                {current ? (
                  <ButtonLink href={step.href} variant="primary" size="sm">
                    {step.label}
                  </ButtonLink>
                ) : (
                  <span className="text-sm text-muted-foreground">
                    {step.label}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          {t("sharedHint")}
        </p>
      )}
      <Button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label={t("dismiss")}
        variant="ghost"
        size="icon"
        className="absolute right-2 top-2"
      >
        <X className="size-4" />
      </Button>
    </section>
  );
}
