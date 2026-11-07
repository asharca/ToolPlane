"use client";

import {
  useId,
  useRef,
  useState,
  type ClipboardEvent,
  type Dispatch,
  type KeyboardEvent,
  type SetStateAction,
} from "react";
import { useTranslations } from "next-intl";
import { Megaphone, X } from "lucide-react";
import { Button } from "@/components/motion/button";
import { Input } from "@/components/motion/input";
import {
  CenterMorphModal,
  CenterMorphModalContent,
  CenterMorphModalTrigger,
} from "@/components/motion/center-morph-modal";
import { Tabs, TabsList, TabsTrigger } from "@/components/motion/tabs";
import {
  DialogBody,
  DialogCancel,
  DialogFooter,
  DialogHeader,
} from "@/components/dashboard/dialog";
import { notify } from "@/components/dashboard/Toaster";
import {
  publishSiteNotificationAction,
  publishWorkspaceNotificationAction,
} from "@/lib/notifications/actions";
import { cn } from "@/lib/utils";

export type NotificationRecipientOption = { name: string; email: string };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SEPARATOR = /[\s,;，；]+/;
const MAX_RECIPIENTS = 100;
const TITLE_MAX = 120;
const BODY_MAX = 5000;
const SUGGESTION_LIMIT = 6;

type Audience = "all" | "selected";

type NotificationDraft = {
  title: string;
  body: string;
  audience: Audience;
  emails: string[];
};

const EMPTY_DRAFT: NotificationDraft = {
  title: "",
  body: "",
  audience: "all",
  emails: [],
};

/** Workspace owners and admins publish from the workspace inbox. */
export function PublishWorkspaceNotification({
  workspaceSlug,
  members,
}: {
  workspaceSlug: string;
  members: NotificationRecipientOption[];
}) {
  const t = useTranslations("console.notifications");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // Lives outside the dialog content so dismissing the dialog keeps the draft.
  const draft = useState<NotificationDraft>(EMPTY_DRAFT);
  return (
    <CenterMorphModal
      open={open}
      onOpenChange={(next) => {
        if (!busy) setOpen(next);
      }}
    >
      <CenterMorphModalTrigger>
        <Button type="button" variant="primary" size="sm">
          <Megaphone className="size-4" aria-hidden />
          {t("publish")}
        </Button>
      </CenterMorphModalTrigger>
      <CenterMorphModalContent
        ariaLabel={t("publishWorkspaceTitle")}
        dismissible={!busy}
        showCloseButton={!busy}
      >
        <NotificationComposer
          draftState={draft}
          variant="dialog"
          workspaceSlug={workspaceSlug}
          recipients={members}
          onBusyChange={setBusy}
          onPublished={() => setOpen(false)}
        />
      </CenterMorphModalContent>
    </CenterMorphModal>
  );
}

export function NotificationComposer({
  variant = "page",
  workspaceSlug,
  recipients,
  draftState,
  onBusyChange,
  onPublished,
}: {
  variant?: "page" | "dialog";
  /** Omit for a site-wide notification. */
  workspaceSlug?: string;
  /** Known recipients offered as suggestions; the server still validates. */
  recipients?: NotificationRecipientOption[];
  onBusyChange?: (busy: boolean) => void;
  /** Externally held draft; defaults to local state. */
  draftState?: [NotificationDraft, Dispatch<SetStateAction<NotificationDraft>>];
  onPublished?: () => void;
}) {
  const t = useTranslations("console.notifications");
  const id = useId();
  const site = workspaceSlug === undefined;
  const localDraft = useState<NotificationDraft>(EMPTY_DRAFT);
  const [draft, setDraft] = draftState ?? localDraft;
  const { title, body, audience, emails } = draft;
  const update = (patch: Partial<NotificationDraft>) =>
    setDraft((current) => ({ ...current, ...patch }));
  const setTitle = (value: string) => update({ title: value });
  const setBody = (value: string) => update({ body: value });
  const setAudience = (value: Audience) => update({ audience: value });
  const setEmails = (value: string[]) => update({ emails: value });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  const invalid = emails.filter((email) => !EMAIL.test(email));
  const ready =
    title.trim() !== "" &&
    body.trim() !== "" &&
    (audience === "all" ||
      (emails.length > 0 &&
        emails.length <= MAX_RECIPIENTS &&
        invalid.length === 0));

  const setBusy = (busy: boolean) => {
    setPending(busy);
    onBusyChange?.(busy);
  };

  const submit = async () => {
    if (!ready || pending) return;
    setError("");
    const form = new FormData();
    if (!site) form.set("workspace", workspaceSlug);
    form.set("title", title);
    form.set("body", body);
    form.set("audience", audience);
    if (audience === "selected") form.set("emails", emails.join("\n"));
    setBusy(true);
    try {
      const result = await (site
        ? publishSiteNotificationAction
        : publishWorkspaceNotificationAction)({}, form);
      if (result.error) {
        setError(result.error);
        return;
      }
      notify(t("published", { count: result.recipientCount ?? 0 }));
      window.dispatchEvent(new Event("toolplane:notifications-changed"));
      setDraft(EMPTY_DRAFT);
      onPublished?.();
    } catch {
      setError(t("errors.failed"));
    } finally {
      setBusy(false);
    }
  };

  const fields = (
    <fieldset disabled={pending} className="min-w-0 space-y-5">
      <div className="space-y-2">
        <label htmlFor={`${id}-title`} className="block text-sm font-medium">
          {t("subject")}
        </label>
        <Input
          id={`${id}-title`}
          required
          autoFocus={variant === "dialog"}
          maxLength={TITLE_MAX}
          value={title}
          onChange={(value) => {
            setTitle(value);
            setError("");
          }}
          className="w-full"
        />
      </div>
      <div className="space-y-2">
        <div className="flex items-baseline justify-between gap-3">
          <label htmlFor={`${id}-body`} className="block text-sm font-medium">
            {t("body")}
          </label>
          {body.length > BODY_MAX * 0.8 ? (
            <span className="text-xs tabular-nums text-muted-foreground">
              {body.length}/{BODY_MAX}
            </span>
          ) : null}
        </div>
        <textarea
          id={`${id}-body`}
          required
          maxLength={BODY_MAX}
          rows={variant === "dialog" ? 5 : 7}
          value={body}
          onChange={(event) => {
            setBody(event.target.value);
            setError("");
          }}
          className="block w-full min-w-0 resize-y rounded-lg border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
        />
      </div>
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span id={`${id}-audience`} className="text-sm font-medium">
            {t("audience")}
          </span>
          <Tabs
            value={audience}
            onValueChange={(value) => {
              setAudience(value as Audience);
              setError("");
            }}
            variant="segment"
          >
            <TabsList aria-labelledby={`${id}-audience`}>
              <TabsTrigger value="all">
                {t(site ? "siteAllAudience" : "workspaceAllAudience")}
              </TabsTrigger>
              <TabsTrigger value="selected">
                {t(site ? "siteSelectedAudience" : "workspaceSelectedAudience")}
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
        {audience === "all" ? (
          <p className="text-sm text-muted-foreground">
            {t(site ? "siteAudienceHelp" : "workspaceAudienceHelp")}
          </p>
        ) : (
          <RecipientInput
            labelledBy={`${id}-audience`}
            emails={emails}
            onChange={(next) => {
              setEmails(next);
              setError("");
            }}
            options={recipients ?? []}
            invalidCount={invalid.length}
          />
        )}
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </fieldset>
  );

  const submitButton = (
    <Button
      type="submit"
      variant="primary"
      size="md"
      disabled={!ready || pending}
    >
      {pending ? t("working") : t("publish")}
    </Button>
  );

  return (
    <form
      aria-busy={pending}
      className={cn(variant === "dialog" && "flex min-h-0 flex-col")}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {variant === "dialog" ? (
        <>
          <DialogHeader title={t("publishWorkspaceTitle")} />
          <DialogBody>{fields}</DialogBody>
          <DialogFooter cancel={<DialogCancel disabled={pending} />}>
            {submitButton}
          </DialogFooter>
        </>
      ) : (
        <div className="space-y-5">
          {fields}
          <div className="flex justify-end">{submitButton}</div>
        </div>
      )}
    </form>
  );
}

function RecipientInput({
  labelledBy,
  emails,
  onChange,
  options,
  invalidCount,
}: {
  labelledBy: string;
  emails: string[];
  onChange: (emails: string[]) => void;
  options: NotificationRecipientOption[];
  invalidCount: number;
}) {
  const t = useTranslations("console.notifications");
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState("");
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(0);

  const term = draft.trim().toLowerCase();
  const selected = new Set(emails);
  const suggestions = options
    .filter(
      (option) =>
        !selected.has(option.email.toLowerCase()) &&
        (!term ||
          option.email.toLowerCase().includes(term) ||
          option.name.toLowerCase().includes(term)),
    )
    .slice(0, SUGGESTION_LIMIT);
  const showSuggestions = focused && suggestions.length > 0;
  const highlighted = Math.min(active, suggestions.length - 1);

  const add = (values: string[]) => {
    const next = [...emails];
    for (const value of values) {
      const email = value.trim().toLowerCase();
      if (email && !next.includes(email)) next.push(email);
    }
    onChange(next.slice(0, MAX_RECIPIENTS));
    setDraft("");
    setActive(0);
  };
  const remove = (email: string) =>
    onChange(emails.filter((value) => value !== email));

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (showSuggestions && event.key === "ArrowDown") {
      event.preventDefault();
      setActive((highlighted + 1) % suggestions.length);
    } else if (showSuggestions && event.key === "ArrowUp") {
      event.preventDefault();
      setActive((highlighted - 1 + suggestions.length) % suggestions.length);
    } else if (event.key === "Enter") {
      // Enter commits the recipient instead of submitting the form.
      if (!term && !showSuggestions) return;
      event.preventDefault();
      if (showSuggestions && (term === "" || !EMAIL.test(term)))
        add([suggestions[highlighted].email]);
      else if (term) add([term]);
    } else if (
      (event.key === "," || event.key === ";" || event.key === " ") &&
      term
    ) {
      event.preventDefault();
      add([term]);
    } else if (event.key === "Backspace" && !draft && emails.length) {
      remove(emails[emails.length - 1]);
    } else if (event.key === "Escape" && showSuggestions) {
      event.preventDefault();
      event.stopPropagation();
      setFocused(false);
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData("text");
    if (!SEPARATOR.test(text.trim())) return;
    event.preventDefault();
    add(text.split(SEPARATOR));
  };

  return (
    <div className="space-y-2">
      <div>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: focuses the inner input */}
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: keyboard users reach the input directly */}
        <div
          className="flex min-h-10 w-full flex-wrap items-center gap-1.5 rounded-lg border border-input bg-background px-2 py-1.5 focus-within:ring-2 focus-within:ring-ring"
          onClick={() => inputRef.current?.focus()}
        >
          {emails.map((email) => {
            const valid = EMAIL.test(email);
            const option = options.find(
              (candidate) => candidate.email.toLowerCase() === email,
            );
            return (
              <span
                key={email}
                title={email}
                className={cn(
                  "inline-flex max-w-full items-center gap-1 rounded-md py-0.5 pl-2 pr-1 text-xs",
                  valid
                    ? "bg-muted text-foreground"
                    : "bg-destructive/10 text-destructive",
                )}
              >
                <span className="truncate">{option?.name ?? email}</span>
                <button
                  type="button"
                  aria-label={t("removeRecipient", { email })}
                  className="rounded p-0.5 text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
                  onClick={(event) => {
                    event.stopPropagation();
                    remove(email);
                  }}
                >
                  <X className="size-3" aria-hidden />
                </button>
              </span>
            );
          })}
          <input
            ref={inputRef}
            type="text"
            inputMode="email"
            autoComplete="off"
            role="combobox"
            aria-labelledby={labelledBy}
            aria-expanded={showSuggestions}
            aria-controls={listId}
            aria-activedescendant={
              showSuggestions ? `${listId}-${highlighted}` : undefined
            }
            value={draft}
            placeholder={
              emails.length
                ? ""
                : t(
                    options.length
                      ? "recipientsPlaceholder"
                      : "siteRecipientsPlaceholder",
                  )
            }
            onChange={(event) => {
              setDraft(event.target.value);
              setActive(0);
              setFocused(true);
            }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onFocus={() => setFocused(true)}
            onBlur={() => {
              setFocused(false);
              if (EMAIL.test(term)) add([term]);
            }}
            className="h-7 min-w-32 flex-1 bg-transparent px-1 text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        {showSuggestions ? (
          <div
            id={listId}
            role="listbox"
            className="mt-1 max-h-48 overflow-y-auto rounded-lg border border-border bg-popover p-1"
          >
            {suggestions.map((option, index) => (
              <button
                key={option.email}
                id={`${listId}-${index}`}
                type="button"
                role="option"
                tabIndex={-1}
                aria-selected={index === highlighted}
                className="flex w-full items-baseline gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none aria-selected:bg-foreground/5"
                // Keep focus in the input so blur does not close the list first.
                onMouseDown={(event) => event.preventDefault()}
                onPointerMove={() => setActive(index)}
                onClick={() => add([option.email])}
              >
                <span className="truncate">{option.name}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {option.email}
                </span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
      {invalidCount > 0 || emails.length >= MAX_RECIPIENTS ? (
        <p
          className={cn(
            "text-xs",
            invalidCount > 0 ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {invalidCount > 0
            ? t("invalidEmails", { count: invalidCount })
            : t("recipientLimit", { count: MAX_RECIPIENTS })}
        </p>
      ) : null}
    </div>
  );
}
