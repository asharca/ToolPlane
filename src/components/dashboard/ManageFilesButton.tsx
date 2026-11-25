"use client";

import { useParams, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/motion/button";
import { cn } from "@/lib/utils";

/** Error code the attachment upload route returns when the owner's quota is full. */
export const STORAGE_QUOTA_EXCEEDED = "STORAGE_QUOTA_EXCEEDED";

/** Opens the workspace Files page so the user can free storage. */
export function ManageFilesButton({ className }: { className?: string }) {
  const t = useTranslations("console.settings");
  const router = useRouter();
  const { workspace } = useParams<{ workspace?: string }>();
  if (!workspace) return null;
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className={cn("rounded-full", className)}
      onClick={() => router.push(`/app/${encodeURIComponent(workspace)}/files`)}
    >
      {t("manageFiles")}
    </Button>
  );
}
