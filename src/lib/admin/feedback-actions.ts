"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { UpdateAdminFeedbackInputSchema } from "@/lib/feedback/types";
import { logSystemEvent } from "@/lib/observability/system";
import { actionScope } from "@/lib/workspace/action-scope";

export type UpdateAdminFeedbackActionResult =
  | { ok: true }
  | { ok: false; error: string };

function normalizeRawInput(rawInput: unknown): unknown {
  if (rawInput instanceof FormData) {
    const adminNoteRaw = rawInput.get("adminNote");
    return {
      id: String(rawInput.get("id") ?? ""),
      status: String(rawInput.get("status") ?? ""),
      adminNote:
        adminNoteRaw === null ? undefined : String(adminNoteRaw).trim() || null,
    };
  }
  return rawInput;
}

export async function updateAdminFeedbackAction(
  rawInput: unknown,
): Promise<UpdateAdminFeedbackActionResult> {
  const admin = await actionScope({ admin: true });
  const parsed = UpdateAdminFeedbackInputSchema.safeParse(
    normalizeRawInput(rawInput),
  );
  if (!parsed.success) {
    return {
      ok: false,
      error: "Invalid feedback update payload.",
    };
  }

  const { id, status, adminNote } = parsed.data;

  try {
    const existing = await db.feedback.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existing) {
      return {
        ok: false,
        error: "Feedback item not found.",
      };
    }

    await db.feedback.update({
      where: { id },
      data: {
        status,
        adminNote: adminNote !== undefined ? adminNote || null : undefined,
        resolvedAt: status === "resolved" ? new Date() : null,
      },
    });
  } catch (error) {
    logSystemEvent("admin.feedback.update_failed", {
      error,
      actorId: admin.id,
    });
    return {
      ok: false,
      error: "Failed to update feedback status.",
    };
  }

  revalidatePath("/admin/feedback");
  revalidatePath(`/admin/feedback/${id}`);
  return { ok: true };
}
