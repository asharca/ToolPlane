"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { updateAdminFeedbackAction } from "@/lib/admin/feedback-actions";
import { FEEDBACK_STATUSES, type FeedbackStatus } from "@/lib/feedback/types";
import { displayErrorText } from "@/components/dashboard/display-error";
import { notify } from "@/components/dashboard/Toaster";
import { FormSelect } from "@/components/ui/FormSelect";
import { Button } from "@/components/motion/button";

export function AdminFeedbackStatusForm({
  id,
  initialStatus,
  initialAdminNote,
}: {
  id: string;
  initialStatus: FeedbackStatus;
  initialAdminNote: string;
}) {
  const t = useTranslations("adminFeedback");
  const router = useRouter();
  const [status, setStatus] = useState<FeedbackStatus>(initialStatus);
  const [adminNote, setAdminNote] = useState(initialAdminNote);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    try {
      const result = await updateAdminFeedbackAction({
        id,
        status,
        adminNote: adminNote.trim() || null,
      });
      if (
        result &&
        typeof result === "object" &&
        "error" in result &&
        result.error
      ) {
        notify(String(result.error), { severity: "error" });
        return;
      }
      notify(t("updateSuccess"), { severity: "info" });
      router.refresh();
    } catch (error) {
      notify(displayErrorText(error, t("updateFailed")), {
        severity: "error",
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-1.5">
        <label
          htmlFor="admin-feedback-status"
          className="text-xs font-medium text-foreground"
        >
          {t("statusColumn")}
        </label>
        <FormSelect
          id="admin-feedback-status"
          name="status"
          value={status}
          onValueChange={(value) => setStatus(value as FeedbackStatus)}
          label={t("statusColumn")}
          options={FEEDBACK_STATUSES.map((value) => ({
            value,
            label: t(`statuses.${value}`),
          }))}
        />
      </div>

      <div className="space-y-1.5">
        <label
          htmlFor="admin-feedback-note"
          className="text-xs font-medium text-foreground"
        >
          {t("adminNoteLabel")}
        </label>
        <textarea
          id="admin-feedback-note"
          value={adminNote}
          onChange={(e) => setAdminNote(e.target.value)}
          maxLength={4000}
          rows={5}
          placeholder={t("adminNotePlaceholder")}
          className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </div>

      <Button type="submit" disabled={saving} className="w-full">
        {saving ? t("saving") : t("saveButton")}
      </Button>
    </form>
  );
}
