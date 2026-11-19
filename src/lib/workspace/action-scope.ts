import "server-only";
import { requireAdmin } from "@/lib/auth/admin";
import { getCurrentUser, type CurrentUser } from "@/lib/auth/current-user";
import {
  resolveWorkspaceScope,
  type WorkspaceCapability,
  type WorkspaceScope,
} from "./scope";

type WorkspaceActionOptions<C extends WorkspaceCapability> = {
  slug: string;
  capability: C;
  ownerOnly?: boolean;
};

type WorkspaceActionContext<C extends WorkspaceCapability> = {
  user: CurrentUser;
  ws: WorkspaceScope<C>;
};

export function actionScope(): Promise<CurrentUser | null>;
export function actionScope(options: { admin: true }): Promise<CurrentUser>;
export function actionScope(
  options: Omit<WorkspaceActionOptions<"read">, "capability">,
): Promise<WorkspaceActionContext<"read"> | null>;
export function actionScope<C extends WorkspaceCapability>(
  options: WorkspaceActionOptions<C>,
): Promise<WorkspaceActionContext<C> | null>;
export async function actionScope(
  options?:
    | { admin: true }
    | (Omit<WorkspaceActionOptions<WorkspaceCapability>, "capability"> & {
        capability?: WorkspaceCapability;
      }),
) {
  if (options && "admin" in options) return requireAdmin();
  const user = await getCurrentUser();
  if (!user || !options) return user;
  const ws = await resolveWorkspaceScope(
    { slug: options.slug },
    user.id,
    options.capability ?? "read",
  );
  if (!ws || (options.ownerOnly && ws.ownerId !== user.id)) return null;
  return { user, ws };
}
