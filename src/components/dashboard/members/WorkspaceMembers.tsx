"use client";

import { useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import {
  ArrowRightLeft,
  LogOut,
  Mail,
  MoreHorizontal,
  Send,
  ShieldCheck,
  Trash2,
  UserMinus,
  UserPlus,
} from "lucide-react";
import { Button, ButtonLink } from "@/components/motion/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/motion/popover";
import {
  CenterMorphModal,
  CenterMorphModalContent,
  CenterMorphModalTrigger,
} from "@/components/motion/center-morph-modal";
import { FormSelect } from "@/components/ui/FormSelect";
import { ConfirmSubmitButton } from "@/components/dashboard/ConfirmSubmitButton";
import {
  DashboardFilterInput,
  DashboardSection,
} from "@/components/dashboard/DashboardUI";
import { notify } from "@/components/dashboard/Toaster";
import {
  leaveWorkspaceAction,
  removeWorkspaceMemberAction,
  revokeWorkspaceInvitationAction,
  setWorkspaceMemberRoleAction,
  type WorkspaceActionState,
} from "@/lib/workspace/management-actions";
import { InviteMemberDialogContent } from "./InviteMemberDialog";

export type WorkspaceRole = "owner" | "admin" | "member";

export type WorkspaceMemberItem = {
  userId: string;
  name: string;
  email: string;
  role: WorkspaceRole;
  joined: string;
  isSelf: boolean;
};

export type WorkspaceInvitationItem = {
  id: string;
  email: string;
  expires: string;
  expired: boolean;
};

/** Search appears once the list no longer fits at a glance. */
const SEARCH_THRESHOLD = 8;

export function WorkspaceMembers({
  slug,
  members,
  invitations,
  canManage,
}: {
  slug: string;
  members: WorkspaceMemberItem[];
  invitations: WorkspaceInvitationItem[];
  /** Owner-only: invite, assign roles, remove members, revoke invitations. */
  canManage: boolean;
}) {
  const t = useTranslations("console.members");
  const [query, setQuery] = useState("");
  const [invite, setInvite] = useState({ open: false, email: "", key: 0 });
  const [inviteBusy, setInviteBusy] = useState(false);
  const term = query.trim().toLocaleLowerCase();
  const matches = (...values: string[]) =>
    !term || values.some((value) => value.toLocaleLowerCase().includes(term));
  const visibleMembers = members.filter((member) =>
    matches(member.name, member.email),
  );
  const visibleInvitations = invitations.filter((invitation) =>
    matches(invitation.email),
  );
  const openInvite = (email = "") =>
    setInvite((state) => ({ open: true, email, key: state.key + 1 }));

  return (
    <div className="space-y-8">
      <DashboardSection
        title={t("members")}
        count={members.length}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <RolePermissions />
            {canManage ? (
              <CenterMorphModal
                open={invite.open}
                onOpenChange={(open) => {
                  if (!inviteBusy) setInvite((state) => ({ ...state, open }));
                }}
              >
                <CenterMorphModalTrigger>
                  <Button
                    type="button"
                    variant="primary"
                    size="sm"
                    onClick={(event) => {
                      event.preventDefault();
                      openInvite();
                    }}
                  >
                    <UserPlus className="size-4" aria-hidden />
                    {t("invite")}
                  </Button>
                </CenterMorphModalTrigger>
                <CenterMorphModalContent
                  ariaLabel={t("invite")}
                  dismissible={!inviteBusy}
                  showCloseButton={!inviteBusy}
                >
                  <InviteMemberDialogContent
                    key={invite.key}
                    slug={slug}
                    initialEmail={invite.email}
                    onBusyChange={setInviteBusy}
                  />
                </CenterMorphModalContent>
              </CenterMorphModal>
            ) : null}
          </div>
        }
      >
        {members.length + invitations.length > SEARCH_THRESHOLD ? (
          <DashboardFilterInput
            value={query}
            onChange={setQuery}
            placeholder={t("search")}
          />
        ) : null}
        {visibleMembers.length ? (
          <RowList>
            {visibleMembers.map((member) => (
              <MemberRow
                // Remount after a server refresh so the role control resyncs.
                key={`${member.userId}:${member.role}`}
                slug={slug}
                member={member}
                canManage={canManage}
              />
            ))}
          </RowList>
        ) : (
          <p className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
            {t("noMatches")}
          </p>
        )}
      </DashboardSection>

      {canManage && visibleInvitations.length ? (
        <DashboardSection
          title={t("pendingInvitations")}
          count={invitations.length}
        >
          <RowList>
            {visibleInvitations.map((invitation) => (
              <InvitationRow
                key={invitation.id}
                slug={slug}
                invitation={invitation}
                onReinvite={() => openInvite(invitation.email)}
              />
            ))}
          </RowList>
        </DashboardSection>
      ) : null}
    </div>
  );
}

function RowList({ children }: { children: ReactNode }) {
  return (
    <ul className="divide-y divide-border rounded-xl border border-border bg-card">
      {children}
    </ul>
  );
}

function Avatar({ children }: { children: ReactNode }) {
  return (
    <span
      aria-hidden
      className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground"
    >
      {children}
    </span>
  );
}

function useRoleLabel() {
  const t = useTranslations("console.members");
  return (role: WorkspaceRole) =>
    role === "owner"
      ? t("ownerRole")
      : role === "admin"
        ? t("adminRole")
        : t("memberRole");
}

function MemberRow({
  slug,
  member,
  canManage,
}: {
  slug: string;
  member: WorkspaceMemberItem;
  canManage: boolean;
}) {
  const t = useTranslations("console.members");
  const workspaces = useTranslations("console.workspaces");
  const roleLabel = useRoleLabel();
  const [role, setRole] = useState(member.role);
  const [saving, setSaving] = useState(false);
  const editable = canManage && member.role !== "owner" && !member.isSelf;
  const removable = canManage && member.role !== "owner" && !member.isSelf;
  const leavable = member.isSelf && member.role !== "owner";
  const transferable = member.isSelf && member.role === "owner" && canManage;

  const changeRole = async (next: string) => {
    if ((next !== "admin" && next !== "member") || next === role) return;
    const previous = role;
    setRole(next);
    setSaving(true);
    const form = new FormData();
    form.set("workspace", slug);
    form.set("memberId", member.userId);
    form.set("role", next);
    try {
      const result = await setWorkspaceMemberRoleAction({}, form);
      if (result.error) {
        setRole(previous);
        notify(result.error, { severity: "error" });
      } else {
        notify(t("roleUpdated", { name: member.name, role: roleLabel(next) }));
      }
    } catch {
      setRole(previous);
      notify(workspaces("errors.failed"), { severity: "error" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <Avatar>{member.name.slice(0, 1).toUpperCase()}</Avatar>
      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
          <span className="truncate">{member.name}</span>
          {member.isSelf ? (
            <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-normal leading-none text-muted-foreground">
              {t("you")}
            </span>
          ) : null}
        </p>
        <p className="truncate text-xs text-muted-foreground">{member.email}</p>
      </div>
      <span className="hidden shrink-0 text-xs text-muted-foreground md:block">
        {t("joinedOn", { date: member.joined })}
      </span>
      <div className="w-28 shrink-0 sm:w-32">
        {editable ? (
          <FormSelect
            label={t("roleFor", { name: member.name })}
            value={role}
            onValueChange={(next) => void changeRole(next)}
            disabled={saving}
            options={[
              { value: "member", label: t("memberRole") },
              { value: "admin", label: t("adminRole") },
            ]}
          />
        ) : (
          <span className="block px-3 text-sm text-muted-foreground">
            {roleLabel(role)}
          </span>
        )}
      </div>
      <RowMenu label={t("actionsFor", { name: member.name })}>
        {removable ? (
          <ConfirmAction
            action={removeWorkspaceMemberAction}
            fields={{ memberId: member.userId }}
            slug={slug}
            icon={<UserMinus className="size-3.5" aria-hidden />}
            label={t("remove")}
            prompt={t("removePrompt", { name: member.name })}
            success={t("removed", { name: member.name })}
          />
        ) : leavable ? (
          <ConfirmAction
            action={leaveWorkspaceAction}
            slug={slug}
            icon={<LogOut className="size-3.5" aria-hidden />}
            label={t("leave")}
            prompt={t("leavePrompt")}
          />
        ) : transferable ? (
          <ButtonLink
            href={`/app/${encodeURIComponent(slug)}/settings`}
            variant="ghost"
            size="sm"
            className="w-full justify-start"
          >
            <ArrowRightLeft className="size-3.5" aria-hidden />
            {t("transferOwnership")}
          </ButtonLink>
        ) : null}
      </RowMenu>
    </li>
  );
}

function InvitationRow({
  slug,
  invitation,
  onReinvite,
}: {
  slug: string;
  invitation: WorkspaceInvitationItem;
  onReinvite: () => void;
}) {
  const t = useTranslations("console.members");
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <span
        aria-hidden
        className="flex size-9 shrink-0 items-center justify-center rounded-full border border-dashed border-border text-muted-foreground"
      >
        <Mail className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{invitation.email}</p>
        <p
          className={
            invitation.expired
              ? "text-xs text-amber-600 dark:text-amber-400"
              : "text-xs text-muted-foreground"
          }
        >
          {invitation.expired
            ? t("expired")
            : t("expiresOn", { date: invitation.expires })}
        </p>
      </div>
      <RowMenu label={t("actionsFor", { name: invitation.email })}>
        {(close) => (
          <>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="w-full justify-start"
              onClick={() => {
                close();
                onReinvite();
              }}
            >
              <Send className="size-3.5" aria-hidden />
              {t("reinvite")}
            </Button>
            <ConfirmAction
              action={revokeWorkspaceInvitationAction}
              fields={{ invitationId: invitation.id }}
              slug={slug}
              icon={<Trash2 className="size-3.5" aria-hidden />}
              label={t("revoke")}
              prompt={t("revokePrompt", { email: invitation.email })}
              success={t("revoked", { email: invitation.email })}
            />
          </>
        )}
      </RowMenu>
    </li>
  );
}

function RowMenu({
  label,
  children,
}: {
  label: string;
  children: ReactNode | ((close: () => void) => ReactNode);
}) {
  const [open, setOpen] = useState(false);
  const content =
    typeof children === "function" ? children(() => setOpen(false)) : children;
  // Keep the column aligned for rows without actions.
  if (!content) return <span aria-hidden className="size-8 shrink-0" />;
  return (
    <Popover align="end" open={open} onOpenChange={setOpen}>
      <PopoverTrigger>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={label}
          className="size-8 shrink-0"
        >
          <MoreHorizontal className="size-4" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 max-w-[calc(100vw-2rem)] space-y-1 p-2">
        {content}
      </PopoverContent>
    </Popover>
  );
}

function ConfirmAction({
  action,
  slug,
  fields = {},
  icon,
  label,
  prompt,
  success,
}: {
  action: (
    state: WorkspaceActionState,
    form: FormData,
  ) => Promise<WorkspaceActionState>;
  slug: string;
  fields?: Record<string, string>;
  icon: ReactNode;
  label: string;
  prompt: string;
  success?: string;
}) {
  const common = useTranslations("common");
  const workspaces = useTranslations("console.workspaces");
  return (
    <form
      action={async (form) => {
        try {
          // Leaving redirects on success and never returns a state.
          const result = await action({}, form);
          if (result?.error) notify(result.error, { severity: "error" });
          else if (success) notify(success);
        } catch (error) {
          if (isRedirect(error)) throw error;
          notify(workspaces("errors.failed"), { severity: "error" });
        }
      }}
    >
      <input type="hidden" name="workspace" value={slug} />
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <ConfirmSubmitButton
        triggerLabel={
          <>
            {icon}
            {label}
          </>
        }
        confirmLabel={common("confirm")}
        cancelLabel={common("cancel")}
        prompt={prompt}
        pendingLabel={`${label}…`}
        promptClassName="w-full break-words text-xs text-muted-foreground"
        className="flex-wrap"
        triggerClassName="w-full justify-start text-destructive hover:text-destructive"
        triggerVariant="ghost"
        triggerSize="sm"
        confirmVariant="primary"
        confirmSize="sm"
        cancelVariant="ghost"
        cancelSize="sm"
      />
    </form>
  );
}

function isRedirect(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "digest" in error &&
    typeof error.digest === "string" &&
    error.digest.startsWith("NEXT_REDIRECT")
  );
}

function RolePermissions() {
  const t = useTranslations("console.members");
  const roles: Array<[string, string]> = [
    [t("ownerRole"), t("ownerCapabilities")],
    [t("adminRole"), t("adminCapabilities")],
    [t("memberRole"), t("memberCapabilities")],
  ];
  return (
    <Popover align="end">
      <PopoverTrigger>
        <Button type="button" variant="ghost" size="sm">
          <ShieldCheck className="size-4" aria-hidden />
          {t("rolePermissions")}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 max-w-[calc(100vw-2rem)] p-4">
        <dl className="space-y-3 text-sm">
          {roles.map(([role, capabilities]) => (
            <div key={role}>
              <dt className="font-medium">{role}</dt>
              <dd className="mt-0.5 text-muted-foreground">{capabilities}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 border-t border-border pt-3 text-xs text-muted-foreground">
          {t("platformRoleNote")}
        </p>
      </PopoverContent>
    </Popover>
  );
}
