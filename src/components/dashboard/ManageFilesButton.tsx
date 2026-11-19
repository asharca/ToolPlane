"use client";

import { useParams, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/motion/button";
import { cn } from "@/lib/utils";

/** Error code the attachment upload route returns when the owner's quota is full. */
export const STORAGE_QUOTA_EXCEEDED = "STORAGE_QUOTA_EXCEEDED";

/** Opens the workspace Files settings so the user can free storage; closing returns here. */
export function ManageFilesButton({
  returnTo,
  className,
}: {
  returnTo?: string;
  className?: string;
}) {
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
      onClick={() =>
        router.push(
          `/app/${encodeURIComponent(workspace)}/settings/files?returnTo=${encodeURIComponent(
            returnTo ?? `${window.location.pathname}${window.location.search}`,
          )}`,
        )
      }
    >
      {t("manageFiles")}
    </Button>
  );
}
