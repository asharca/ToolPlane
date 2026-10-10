"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getWorkspaceForUser } from "@/lib/workspace/queries";
import { originFromHeaders } from "@/lib/http/origin";
import { updatePiPackageMcpBindings } from "@/lib/market/resources";
import { MarketError } from "@/lib/market/skills";
import {
  createPiPackageClientInstallation,
  updatePiPackageClientInstallation,
  revokePiPackageClientInstallation,
  piPackageBindingsSchema,
  piPackageClientSchema,
  PiInstallationError,
} from "@/lib/pi-packages/installations";

export type PiClientActionState = {
  ok?: boolean;
  error?: string;
  privateConfig?: {
    baseUrl: string;
    installationId: string;
    token: string;
    client: string;
  };
};

export async function managePiPackageClientAction(
  _previous: PiClientActionState,
  formData: FormData,
): Promise<PiClientActionState> {
  const user = await getCurrentUser();
  const slug = String(formData.get("workspace") ?? "");
  const workspace = user ? await getWorkspaceForUser(slug, user.id) : null;
  if (!workspace || !user) return { error: "pi_installation_forbidden" };
  const context = { workspaceId: workspace.id, userId: user.id };
  try {
    const operation = String(formData.get("operation") ?? "");
    const installationId = String(formData.get("installationId") ?? "");
    if (operation === "revoke") {
      await revokePiPackageClientInstallation({ ...context, installationId });
    } else {
      const bindings = piPackageBindingsSchema.parse(
        JSON.parse(String(formData.get("bindings") ?? "{}")),
      );
      if (operation === "workspace-bindings") {
        if (formData.get("confirmExpandedPrivileges") !== "yes")
          return { error: "pi_package_privileges_confirmation_required" };
        await updatePiPackageMcpBindings({
          ...context,
          marketInstallId: String(formData.get("marketInstallId") ?? ""),
          mcpBindings: bindings,
        });
        revalidatePath(`/app/${slug}/market/installed`, "layout");
        return { ok: true };
      }
      if (operation === "create") {
        const baseUrl = originFromHeaders(await headers());
        const { installation, token } = await createPiPackageClientInstallation(
          {
            ...context,
            marketInstallId: String(formData.get("marketInstallId") ?? ""),
            label: String(formData.get("label") ?? ""),
            client: piPackageClientSchema.parse(formData.get("client")),
            bindings,
          },
        );
        revalidatePath(`/app/${slug}/market/installed`);
        return {
          ok: true,
          privateConfig: {
            baseUrl,
            installationId: installation.id,
            token,
            client: installation.client,
          },
        };
      }
      if (operation !== "update")
        return { error: "pi_package_invalid_bindings" };
      await updatePiPackageClientInstallation({
        ...context,
        installationId,
        releaseId: String(formData.get("releaseId") ?? ""),
        bindings,
        confirmExpandedPrivileges:
          formData.get("confirmExpandedPrivileges") === "yes",
      });
    }
    revalidatePath(`/app/${slug}/market/installed`, "layout");
    return { ok: true };
  } catch (error) {
    return {
      error:
        error instanceof PiInstallationError || error instanceof MarketError
          ? error.code
          : "pi_client_action_failed",
    };
  }
}
