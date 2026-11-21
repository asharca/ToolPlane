"use client";

import { useTranslations } from "next-intl";
import { AnimatedBadge } from "@/components/motion/animated-badge";
import { isInsecureRemoteMcpUrl } from "@/lib/remote-mcp/url";

export function RemoteMcpTransportNotice({
  url,
  showHelp = false,
}: {
  url: string | null | undefined;
  showHelp?: boolean;
}) {
  const t = useTranslations("console.mcp");
  const insecure = isInsecureRemoteMcpUrl(url ?? "");

  if (!insecure && !showHelp) return null;

  return (
    <div className="space-y-2" data-testid="remote-mcp-transport-notice">
      {showHelp ? (
        <p className="text-xs leading-5 text-muted-foreground">
          {t("remoteTransportHelp")}
        </p>
      ) : null}
      {insecure ? (
        <div role="alert" className="space-y-1.5 text-sm leading-6">
          <AnimatedBadge status="warning">
            {t("remoteTransportHttpTitle")}
          </AnimatedBadge>
          <p>{t("remoteTransportHttpRisk")}</p>
        </div>
      ) : null}
    </div>
  );
}
