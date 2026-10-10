"use client";

import { useActionState, useId, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/motion/button";
import { Input } from "@/components/motion/input";
import { FormSelect } from "@/components/ui/FormSelect";
import {
  publishSiteNotificationAction,
  publishWorkspaceNotificationAction,
  type NotificationActionState,
} from "@/lib/notifications/actions";

export function NotificationPublishForm({
  workspaceSlug,
}: {
  workspaceSlug?: string;
}) {
  const t = useTranslations("console.notifications");
  const id = useId();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [audience, setAudience] = useState("selected");
  const [emails, setEmails] = useState("");
  const [state, action, pending] = useActionState(
    async (previous: NotificationActionState, form: FormData) => {
      let result: NotificationActionState;
      try {
        result = await (workspaceSlug === undefined
          ? publishSiteNotificationAction
          : publishWorkspaceNotificationAction)(previous, form);
      } catch {
        return { error: t("errors.failed") };
      }
      if (result.ok) {
        setTitle("");
        setBody("");
        setAudience("selected");
        setEmails("");
      }
      return result;
    },
    {},
  );
  const textareaClass =
    "block w-full min-w-0 rounded-lg border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60";
  return (
    <form action={action} aria-busy={pending} className="space-y-4">
      {workspaceSlug !== undefined ? (
        <input type="hidden" name="workspace" value={workspaceSlug} />
      ) : null}
      <fieldset
        disabled={pending}
        className="min-w-0 space-y-4 disabled:opacity-60"
      >
        <div className="space-y-2">
          <label htmlFor={`${id}-title`} className="block text-sm font-medium">
            {t("subject")}
          </label>
          <Input
            id={`${id}-title`}
            name="title"
            required
            maxLength={120}
            value={title}
            onChange={setTitle}
            className="w-full"
          />
        </div>
        <div className="space-y-2">
          <label htmlFor={`${id}-body`} className="block text-sm font-medium">
            {t("body")}
          </label>
          <textarea
            id={`${id}-body`}
            name="body"
            required
            maxLength={5000}
            rows={6}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            className={textareaClass}
            aria-describedby={`${id}-plain`}
          />
          <p id={`${id}-plain`} className="text-xs text-muted-foreground">
            {t("plainTextHelp")}
          </p>
        </div>
        <div className="space-y-2">
          <label
            htmlFor={`${id}-audience`}
            className="block text-sm font-medium"
          >
            {t("audience")}
          </label>
          <FormSelect
            id={`${id}-audience`}
            name="audience"
            label={t("audience")}
            value={audience}
            disabled={pending}
            onValueChange={(value) => {
              setAudience(value);
              if (value === "all") setEmails("");
            }}
            options={[
              { value: "selected", label: t("selectedAudience") },
              {
                value: "all",
                label: t(
                  workspaceSlug === undefined
                    ? "siteAllAudience"
                    : "workspaceAllAudience",
                ),
              },
            ]}
          />
          <p className="text-xs text-muted-foreground">
            {t(
              workspaceSlug === undefined
                ? "siteAudienceHelp"
                : "workspaceAudienceHelp",
            )}
          </p>
        </div>
        {audience === "selected" ? (
          <div className="space-y-2">
            <label
              htmlFor={`${id}-emails`}
              className="block text-sm font-medium"
            >
              {t("emails")}
            </label>
            <textarea
              id={`${id}-emails`}
              name="emails"
              required
              maxLength={32100}
              rows={3}
              value={emails}
              onChange={(event) => setEmails(event.target.value)}
              className={textareaClass}
              aria-describedby={`${id}-emails-help`}
            />
            <p
              id={`${id}-emails-help`}
              className="text-xs text-muted-foreground"
            >
              {t("emailsHelp")}
            </p>
          </div>
        ) : null}
        <Button type="submit" disabled={pending}>
          {pending ? t("working") : t("publish")}
        </Button>
      </fieldset>
      {state.error ? (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      ) : null}
      {state.ok && state.recipientCount !== undefined ? (
        <p role="status" className="text-sm">
          {t("published", { count: state.recipientCount })}
        </p>
      ) : null}
    </form>
  );
}
