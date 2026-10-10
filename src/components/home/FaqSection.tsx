"use client";

import { useTranslations } from "next-intl";
import { BouncyAccordion } from "@/components/motion/bouncy-accordion";
const FAQ_KEYS = [
  "faq1",
  "faq2",
  "faq3",
  "faq4",
  "faq5",
  "faq6",
  "faq7",
  "faq8",
] as const;

export function FaqSection() {
  const t = useTranslations("home");
  return (
    <section className="py-12">
      <h2 className="mb-6 text-xl font-semibold tracking-tight text-foreground">
        {t("frequentlyAskedQuestions")}
      </h2>
      <BouncyAccordion
        items={FAQ_KEYS.map((key) => ({
          id: key,
          title: t(`${key}.q`),
          description: t(`${key}.a`),
        }))}
      />
    </section>
  );
}
