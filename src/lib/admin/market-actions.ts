"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { requireAdmin } from "@/lib/auth/admin";
import { db } from "@/lib/db";
import {
  deleteDirectoryServer,
  deleteDirectorySkill,
  setServerVerified,
} from "@/lib/admin/market";
import { parseServerRecipe } from "@/lib/workspace/server-recipe";
import { validateServerRecipe } from "@/lib/admin/recipe-validate";
import type { AdminActionState } from "@/lib/admin/user-actions";

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

export async function deleteServerAction(
  _prev: AdminActionState,
  fd: FormData,
): Promise<AdminActionState> {
  const admin = await requireAdmin();
  const t = await getTranslations("admin");
  try {
    await deleteDirectoryServer(str(fd, "id"), admin.id);
  } catch (e) {
    const count =
      e instanceof Error
        ? /^(?:Refused: )?(\d+) live deployment/.exec(e.message)?.[1]
        : undefined;
    return {
      error: count
        ? t("errorServerReferenced", { count: Number(count) })
        : t("errorActionFailed"),
    };
  }
  revalidatePath("/admin/servers");
  redirect("/admin/servers");
}

export async function deleteSkillAction(
  _prev: AdminActionState,
  fd: FormData,
): Promise<AdminActionState> {
  const admin = await requireAdmin();
  const t = await getTranslations("admin");
  try {
    await deleteDirectorySkill(str(fd, "id"), admin.id);
  } catch (e) {
    const count =
      e instanceof Error
        ? /^(?:Refused: )?(\d+) workspace install/.exec(e.message)?.[1]
        : undefined;
    return {
      error: count
        ? t("errorSkillInstalled", { count: Number(count) })
        : t("errorActionFailed"),
    };
  }
  revalidatePath("/admin/skills");
  redirect("/admin/skills");
}

// ---- Server deploy recipes ----

export type RecipeActionState = {
  error?: string;
  ok?: boolean;
  toolCount?: number;
  tools?: string[];
};

// "KEY=value" lines → map (throwaway test values used only during validation).
function envPairs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\n+/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

export async function validateServerRecipeAction(
  _prev: RecipeActionState,
  fd: FormData,
): Promise<RecipeActionState> {
  const admin = await requireAdmin();
  const t = await getTranslations("admin");
  const id = str(fd, "id");
  const server = await db.server.findUnique({
    where: { id },
    select: { installCfg: true, updatedAt: true },
  });
  const recipe = parseServerRecipe(server?.installCfg);
  if (!server || !recipe) return { error: t("errorSaveRecipeFirst") };

  const result = await validateServerRecipe(
    recipe,
    envPairs(str(fd, "testEnv")),
  );
  if (!result.ok)
    return { error: t("errorValidationFailed", { message: result.error }) };

  try {
    await setServerVerified(
      id,
      result.toolCount,
      result.toolCatalog,
      server.updatedAt,
      admin.id,
    );
  } catch {
    return { error: t("errorSaveRecipeFirst") };
  }
  revalidatePath(`/admin/servers/${id}/edit`);
  revalidatePath("/admin/servers");
  return { ok: true, toolCount: result.toolCount, tools: result.tools };
}
