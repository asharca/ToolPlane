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
  removeWorkspaceMemberAction,
  leaveWorkspaceAction,
  revokeWorkspaceInvitationAction,
  transferWorkspaceOwnershipAction,
  acceptWorkspaceInvitationAction,
  setWorkspaceMemberRoleAction,
  type WorkspaceActionState,
} from "@/lib/workspace/management-actions";

type Action = (
  state: WorkspaceActionState,
  data: FormData,
) => Promise<WorkspaceActionState>;

export function WorkspaceActionForm({
  action,
  children,
  label,
  danger = false,
}: {
  action: Action;
  children: ReactNode;
  label: string;
  danger?: boolean;
}) {
  const t = useTranslations("console.workspaces");
  const [state, formAction, pending] = useActionState(action, {});
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
        disabled={pending}
        className="min-w-0 space-y-3 disabled:opacity-60"
      >
        {children}
        <Button
          type="submit"
          variant={danger ? "secondary" : "primary"}
          size="md"
        >
          {pending ? t("working") : label}
        </Button>
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
}: {
  intent?: string;
  autoFocus?: boolean;
}) {
  const t = useTranslations("console.workspaces");
  const id = useId();
  return (
    <WorkspaceActionForm action={createWorkspaceAction} label={t("create")}>
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
        {t("createHint")}
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
  const id = useId();
  return canManage ? (
    <WorkspaceActionForm action={renameWorkspaceAction} label={t("save")}>
      <input type="hidden" name="workspace" value={slug} />
      <label htmlFor={id} className="block text-sm font-medium">
        {t("name")}
      </label>
      <Input
        id={id}
        name="name"
        defaultValue={name}
        required
        maxLength={80}
        className="w-full"
      />
      <p className="break-all text-xs text-muted-foreground">
        {t("stableAddress", { slug })}
      </p>
    </WorkspaceActionForm>
  ) : (
    <div className="space-y-2">
      <p className="font-medium">{name}</p>
      <p className="text-sm text-muted-foreground">{t("ownerOnly")}</p>
    </div>
  );
}

const memberActions = {
  remove: removeWorkspaceMemberAction,
  leave: leaveWorkspaceAction,
  revoke: revokeWorkspaceInvitationAction,
};

export function WorkspaceMemberAction({
  slug,
  memberId,
  invitationId,
  kind,
}: {
  slug: string;
  memberId?: string;
  invitationId?: string;
  kind: keyof typeof memberActions;
}) {
  const t = useTranslations("console.workspaces");
  return (
    <BouncyAccordion
      items={[
        {
          id: "details",
          title: <>{t(kind)}</>,
          description: (
            <>
              <div className="mt-2 rounded-lg border border-border p-3">
                <WorkspaceActionForm
                  action={memberActions[kind]}
                  label={t("confirm")}
                  danger
                >
                  <input type="hidden" name="workspace" value={slug} />
                  <input type="hidden" name="memberId" value={memberId ?? ""} />
                  <input
                    type="hidden"
                    name="invitationId"
                    value={invitationId ?? ""}
                  />
                  <p className="text-muted-foreground">{t(`${kind}Hint`)}</p>
                </WorkspaceActionForm>
              </div>
            </>
          ),
        },
      ]}
    />
  );
}

export function WorkspaceMemberRoleForm({
  slug,
  memberId,
  role,
}: {
  slug: string;
  memberId: string;
  role: "admin" | "member";
}) {
  const t = useTranslations("console.workspaces");
  const id = useId();
  return (
    <WorkspaceActionForm
      action={setWorkspaceMemberRoleAction}
      label={t("save")}
    >
      <input type="hidden" name="workspace" value={slug} />
      <input type="hidden" name="memberId" value={memberId} />
      <label htmlFor={id} className="block text-sm font-medium">
        {t("memberRole")}
      </label>
      <FormSelect
        key={role}
        id={id}
        name="role"
        required
        defaultValue={role}
        label={t("memberRole")}
        options={[
          { value: "member", label: t("member") },
          { value: "admin", label: t("admin") },
        ]}
      />
    </WorkspaceActionForm>
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
                  className="w-full"
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
                  className="w-full"
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
