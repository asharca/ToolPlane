import "server-only";
import { z } from "zod";
import { createTranslator } from "next-intl";
import { loadMessages } from "@/i18n/messages";
import { db } from "@/lib/db";

export const BUDGET_WARNING_PART = "data-budget-warning";
export const BudgetWarningSchema = z.object({
  taskId: z.string().min(1),
  agentId: z.string().min(1),
  month: z.string().regex(/^\d{4}-\d{2}$/),
  spentMicros: z.string().regex(/^\d+$/),
  monthlyBudgetMicros: z.string().regex(/^\d+$/),
  currency: z.literal("USD"),
  unit: z.literal("micros"),
});
export type BudgetWarning = z.infer<typeof BudgetWarningSchema>;

export async function taskBudgetWarning(scope: {
  workspaceId: string;
  agentId: string;
  taskId: string;
}): Promise<BudgetWarning | undefined> {
  const usage = await db.agentUsage.findFirst({
    where: scope,
    select: { budgetWarning: true },
  });
  const parsed = BudgetWarningSchema.safeParse(usage?.budgetWarning);
  return parsed.success ? parsed.data : undefined;
}

/** Only native human-facing entries call this; A2A artifacts remain unchanged. */
export async function appendBudgetWarningText(
  text: string,
  scope: { workspaceId: string; agentId: string; taskId: string },
) {
  if (!(await taskBudgetWarning(scope))) return text;
  const workspace = await db.workspace.findUniqueOrThrow({
    where: { id: scope.workspaceId },
    select: { owner: { select: { locale: true } } },
  });
  const locale = workspace.owner.locale === "zh" ? "zh" : "en";
  const messages = loadMessages(locale);
  const t = createTranslator({ locale, messages: messages.console.agentUsage });
  return `${text}\n\n${t("turnBudgetWarning")}`;
}
