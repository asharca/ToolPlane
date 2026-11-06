import { getLocale, getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/current-user";
import {
  getWorkspaceForUser,
  getWorkspaceMembers,
} from "@/lib/workspace/queries";
import { DashboardHeader } from "@/components/dashboard/DashboardHeader";
import { DashboardPage } from "@/components/dashboard/DashboardUI";
import {
  WorkspaceMembers,
  type WorkspaceRole,
} from "@/components/dashboard/members/WorkspaceMembers";
import { db } from "@/lib/db";
import { formatInTimeZone, resolveUserTimeZone } from "@/lib/timezone";

export const dynamic = "force-dynamic";

const ROLE_ORDER: Record<WorkspaceRole, number> = {
  owner: 0,
  admin: 1,
  member: 2,
};

function fmt(d: Date, timeZone: string, locale: string) {
  return formatInTimeZone(
    d,
    timeZone,
    {
      month: "short",
      day: "numeric",
      year: "numeric",
    },
    locale,
  );
}

export default async function MembersPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const [t, locale] = await Promise.all([
    getTranslations("console.members"),
    getLocale(),
  ]);
  const { workspace: slug } = await params;
  const user = await getCurrentUser();
  if (!user) redirect("/app/login");
  const timeZone = resolveUserTimeZone(user);
  const ws = await getWorkspaceForUser(slug, user.id);
  if (!ws) redirect("/app");
  const isOwner = ws.ownerId === user.id;
  const [members, invitations] = await Promise.all([
    getWorkspaceMembers(ws.id),
    isOwner
      ? db.workspaceInvitation.findMany({
          where: { workspaceId: ws.id },
          orderBy: { createdAt: "desc" },
          select: { id: true, email: true, expiresAt: true },
        })
      : [],
  ]);
  const now = new Date();

  return (
    <>
      <DashboardHeader title={t("members")} />
      <DashboardPage className="max-w-4xl py-8">
        <WorkspaceMembers
          slug={slug}
          canManage={isOwner}
          members={members
            .map((member) => {
              const role: WorkspaceRole =
                member.userId === ws.ownerId
                  ? "owner"
                  : member.role === "admin"
                    ? "admin"
                    : "member";
              return {
                userId: member.userId,
                name: member.user.name ?? member.user.email.split("@")[0],
                email: member.user.email,
                role,
                joined: fmt(member.createdAt, timeZone, locale),
                isSelf: member.userId === user.id,
              };
            })
            .sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role])}
          invitations={invitations.map((invitation) => ({
            id: invitation.id,
            email: invitation.email,
            expires: fmt(invitation.expiresAt, timeZone, locale),
            expired: invitation.expiresAt <= now,
          }))}
        />
      </DashboardPage>
    </>
  );
}
