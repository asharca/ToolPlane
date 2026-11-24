"use client";
import { AnimatedBadge } from "@/components/motion/animated-badge";

import { BouncyAccordion } from "@/components/motion/bouncy-accordion";

import { FormSelect } from "@/components/ui/FormSelect";

import { Button } from "@/components/motion/button";
import { Input } from "@/components/motion/input";

import { useActionState, useId, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import {
  createWorkspaceAction,
  renameWorkspaceAction,
  deleteWorkspaceAction,
  leaveWorkspaceAction,
  transferWorkspaceOwnershipAction,
  acceptWorkspaceInvitationAction,
  type WorkspaceActionState,
} from "@/lib/workspace/management-actions";

export type WorkspaceCreationQuota = {
  ownedWorkspaces: number;
  maxOwnedWorkspaces: number;
};

type Action = (
  state: WorkspaceActionState,
  data: FormData,
) => Promise<WorkspaceActionState>;

export function WorkspaceActionForm({
  action,
  children,
  label,
  danger = false,
  disabled = false,
  submitDisabled = false,
}: {
  action: Action;
  children: ReactNode;
  label: string;
  danger?: boolean;
  disabled?: boolean;
  submitDisabled?: boolean;
}) {
  const t = useTranslations("console.workspaces");
  const [state, formAction, pending] = useActionState(action, {});
  const submit = (
    <Button
      type="submit"
      disabled={disabled || submitDisabled || pending}
      variant={danger ? "secondary" : "primary"}
      size="md"
    >
      {pending ? t("working") : label}
    </Button>
  );
  return (
    <form
      action={formAction}
      className="space-y-3"
      aria-busy={pending}
      data-workspace-navigation={
        action === createWorkspaceAction ? "" : undefined
      }
      data-unsaved-changes={pending ? "true" : undefined}
    >
      <fieldset
        disabled={disabled || pending}
        className="min-w-0 space-y-3 disabled:opacity-60"
      >
        {children}
        {submit}
      </fieldset>
      {state.error ? (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      ) : null}
      {state.success ? (
        <p role="status">
          <AnimatedBadge status="success">{state.success}</AnimatedBadge>
        </p>
      ) : null}
    </form>
  );
}

export function CreateWorkspaceForm({
  intent = "",
  autoFocus = false,
  quota,
}: {
  intent?: string;
  autoFocus?: boolean;
  quota: WorkspaceCreationQuota;
}) {
  const t = useTranslations("console.workspaces");
  const id = useId();
  const atLimit = quota.ownedWorkspaces >= quota.maxOwnedWorkspaces;
  return (
    <WorkspaceActionForm
      action={createWorkspaceAction}
      label={t("create")}
      disabled={atLimit}
    >
      <input type="hidden" name="intent" value={intent} />
      <label htmlFor={id} className="block text-sm font-medium">
        {t("name")}
      </label>
      <Input
        id={id}
        name="name"
        required
        maxLength={80}
        autoFocus={autoFocus}
        placeholder={t("namePlaceholder")}
        className="w-full"
      />
      <p className="text-xs leading-5 text-muted-foreground">
        {atLimit ? t("ownedWorkspaceCount", quota) : t("createHint")}
      </p>
    </WorkspaceActionForm>
  );
}

export function RenameWorkspaceForm({
  slug,
  name,
  canManage,
}: {
  slug: string;
  name: string;
  canManage: boolean;
}) {
  const t = useTranslations("console.workspaces");
  const common = useTranslations("common");
  const id = useId();
  const [value, setValue] = useState(name);
  const [savedName, setSavedName] = useState(name);
  const [state, formAction, pending] = useActionState(
    renameWorkspaceAction,
    {},
  );
  if (savedName !== name) {
    setSavedName(name);
    setValue(name);
  }
  return canManage ? (
    <form
      action={formAction}
      aria-busy={pending}
      data-unsaved-changes={pending || value !== name ? "true" : undefined}
      className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
    >
      <input type="hidden" name="workspace" value={slug} />
      <div className="min-w-0 sm:max-w-md">
        <label
          htmlFor={id}
          className="block text-sm font-medium text-foreground"
        >
          {t("name")}
        </label>
        <p className="mt-0.5 break-all text-xs leading-5 text-muted-foreground">
          {t("stableAddress", { slug })}
        </p>
        {state.error ? (
          <p role="alert" className="mt-1.5 text-xs text-destructive">
            {state.error}
          </p>
        ) : state.success ? (
          <p role="status" className="mt-1.5">
            <AnimatedBadge status="success">{state.success}</AnimatedBadge>
          </p>
        ) : null}
      </div>
      <div className="flex min-w-0 items-center gap-2 sm:w-96">
        <Input
          id={id}
          name="name"
          value={value}
          onChange={setValue}
          required
          maxLength={80}
          disabled={pending}
          className="min-w-0 flex-1"
        />
        <Button
          type="submit"
          disabled={pending || value.trim() === name.trim() || !value.trim()}
          variant="primary"
          size="md"
          className="shrink-0"
        >
          {pending ? t("working") : common("save")}
        </Button>
      </div>
    </form>
  ) : (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 sm:max-w-md">
        <p className="text-sm font-medium text-foreground">{t("name")}</p>
        <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
          {t("ownerOnly")}
        </p>
      </div>
      <p className="text-sm text-foreground">{name}</p>
    </div>
  );
}

export function WorkspaceLeaveAction({ slug }: { slug: string }) {
  const t = useTranslations("console.workspaces");
  return (
    <BouncyAccordion
      items={[
        {
          id: "details",
          title: <>{t("leave")}</>,
          description: (
            <>
              <div className="mt-2 rounded-lg border border-border p-3">
                <WorkspaceActionForm
                  action={leaveWorkspaceAction}
                  label={t("confirm")}
                  danger
                >
                  <input type="hidden" name="workspace" value={slug} />
                  <p className="text-muted-foreground">{t("leaveHint")}</p>
                </WorkspaceActionForm>
              </div>
            </>
          ),
        },
      ]}
    />
  );
}

export function WorkspaceDeleteForm({
  slug,
  name,
  status = "active",
  impact,
}: {
  slug: string;
  name: string;
  status?: string;
  impact?: string;
}) {
  const t = useTranslations("console.workspaces");
  const [confirmation, setConfirmation] = useState("");
  const id = useId();
  const [state, action, pending] = useActionState(deleteWorkspaceAction, {});
  return (
    <BouncyAccordion
      defaultValue={status !== "active" ? "details" : null}
      items={[
        {
          id: "details",
          title: <>{t(status === "active" ? "delete" : "retryDelete")}</>,
          description: (
            <>
              <form action={action} className="space-y-3" aria-busy={pending}>
                <p className="text-muted-foreground">{t("deleteHint")}</p>
                {impact ? (
                  <p className="text-muted-foreground">{impact}</p>
                ) : null}
                <input type="hidden" name="workspace" value={slug} />
                <label htmlFor={id} className="block break-words">
                  {t("typeName", { name })}
                </label>
                <Input
                  id={id}
                  name="confirmation"
                  value={confirmation}
                  onChange={(value) => setConfirmation(value)}
                  required
                  maxLength={80}
                  autoComplete="off"
                  disabled={pending}
                  className="w-full max-w-md"
                />
                <Button
                  type="submit"
                  disabled={pending || confirmation !== name}
                  variant="secondary"
                  size="md"
                >
                  {pending ? t("deleting") : t("confirmDelete")}
                </Button>
                {state.error ? (
                  <p role="alert" className="text-destructive">
                    {state.error}
                  </p>
                ) : null}
              </form>
            </>
          ),
        },
      ]}
    />
  );
}

export function WorkspaceTransferForm({
  slug,
  name,
  members,
}: {
  slug: string;
  name: string;
  members: { userId: string; label: string }[];
}) {
  const t = useTranslations("console.workspaces");
  const id = useId();
  return (
    <BouncyAccordion
      items={[
        {
          id: "details",
          title: <>{t("transfer")}</>,
          description: (
            <>
              <WorkspaceActionForm
                action={transferWorkspaceOwnershipAction}
                label={t("confirmTransfer")}
                danger
              >
                <p className="text-muted-foreground">{t("transferHint")}</p>
                <input type="hidden" name="workspace" value={slug} />
                <label htmlFor={`${id}-member`} className="block">
                  {t("newOwner")}
                </label>
                <FormSelect
                  id={`${id}-member`}
                  name="memberId"
                  required
                  defaultValue=""
                  label={t("newOwner")}
                  className="w-full max-w-md"
                  options={[
                    { value: "", label: t("selectMember"), disabled: true },
                    ...members.map((member) => ({
                      value: member.userId,
                      label: member.label,
                    })),
                  ]}
                />
                <label htmlFor={`${id}-name`} className="block break-words">
                  {t("typeName", { name })}
                </label>
                <Input
                  id={`${id}-name`}
                  name="confirmation"
                  required
                  maxLength={80}
                  autoComplete="off"
                  className="w-full max-w-md"
                />
              </WorkspaceActionForm>
            </>
          ),
        },
      ]}
    />
  );
}

export function AcceptWorkspaceInvitationForm({ token }: { token: string }) {
  const t = useTranslations("console.workspaces");
  return (
    <WorkspaceActionForm
      action={acceptWorkspaceInvitationAction}
      label={t("acceptInvitation")}
    >
      <input type="hidden" name="token" value={token} />
    </WorkspaceActionForm>
  );
}
