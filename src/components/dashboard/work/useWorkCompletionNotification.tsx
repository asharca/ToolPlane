"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, BellOff } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/motion/button";
import { Tooltip } from "@/components/motion/tooltip";
import { notify } from "@/components/dashboard/Toaster";
import { usePersistentBoolean } from "@/lib/use-persistent-boolean";

type Permission = NotificationPermission | "unsupported" | "loading";

function browserPermission(): Permission {
  // The origin lock also prevents two open Work tabs from ringing for one turn.
  if (
    !window.isSecureContext ||
    typeof Notification === "undefined" ||
    !navigator.locks
  )
    return "unsupported";
  return Notification.permission;
}

export function useWorkCompletionNotification(
  workspaceId: string,
  slug: string,
) {
  const t = useTranslations("console.work");
  const [optedIn, setOptedIn] = usePersistentBoolean(
    `toolplane:work-completion-enabled:${workspaceId}`,
    false,
  );
  const [permission, setPermission] = useState<Permission>("loading");
  const [pending, setPending] = useState(false);
  const [deliveryFailed, setDeliveryFailed] = useState(false);
  const mounted = useRef(false);
  const current = useRef({
    optedIn,
    title: t("completionNotificationTitle"),
    failure: t("completionNotificationFailed"),
  });
  useEffect(() => {
    current.current = {
      optedIn,
      title: t("completionNotificationTitle"),
      failure: t("completionNotificationFailed"),
    };
  }, [optedIn, t]);

  useEffect(() => {
    mounted.current = true;
    const update = () => setPermission(browserPermission());
    update();
    window.addEventListener("focus", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      mounted.current = false;
      window.removeEventListener("focus", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);

  const enabled = optedIn && permission === "granted" && !deliveryFailed;
  const label =
    permission === "loading"
      ? t("completionNotificationLoading")
      : permission === "unsupported"
        ? t("completionNotificationUnsupported")
        : permission === "denied"
          ? t("completionNotificationDenied")
          : deliveryFailed
            ? t("completionNotificationFailed")
            : enabled
              ? t("completionNotificationDisable")
              : t("completionNotificationEnable");

  async function toggle() {
    if (pending) return;
    if (optedIn) {
      current.current.optedIn = false;
      setOptedIn(false);
      setDeliveryFailed(false);
      return;
    }
    const status = browserPermission();
    setPermission(status);
    if (status === "unsupported" || status === "denied") {
      notify(
        t(
          status === "denied"
            ? "completionNotificationDenied"
            : "completionNotificationUnsupported",
        ),
        { severity: "warning" },
      );
      return;
    }
    setPending(true);
    try {
      // This is the only permission request path, reached directly by a click.
      const result =
        status === "granted" ? status : await Notification.requestPermission();
      setPermission(result);
      const allowed = result === "granted";
      current.current.optedIn = allowed;
      setOptedIn(allowed);
      setDeliveryFailed(false);
      if (!allowed) {
        notify(
          t(
            result === "denied"
              ? "completionNotificationDenied"
              : "completionNotificationNotEnabled",
          ),
          { severity: "warning" },
        );
      }
    } catch {
      current.current.optedIn = false;
      setOptedIn(false);
      setDeliveryFailed(true);
      notify(t("completionNotificationFailed"), { severity: "warning" });
    } finally {
      setPending(false);
    }
  }

  const notifyCompletion = useCallback(
    (workSessionId: string, startedAt: number) => {
      // No contents, task titles, agent names or workspace names leave the page.
      if (!current.current.optedIn || browserPermission() !== "granted") return;
      if (document.visibilityState !== "hidden" && document.hasFocus()) return;
      const key = `toolplane:work-completion:${workspaceId}:${workSessionId}`;
      void navigator.locks
        .request(key, { ifAvailable: true }, (lock) => {
          if (
            !lock ||
            !mounted.current ||
            !current.current.optedIn ||
            browserPermission() !== "granted" ||
            (document.visibilityState !== "hidden" && document.hasFocus())
          )
            return;
          try {
            const previous = Number(window.localStorage.getItem(key));
            if (previous >= startedAt) return;
            // Claim before delivery, so a failure or second tab never replays it.
            window.localStorage.setItem(key, String(startedAt));
            const notification = new Notification(current.current.title, {
              tag: key,
            });
            notification.onclick = () => {
              notification.close();
              window.focus();
              window.location.assign(
                `/app/${encodeURIComponent(slug)}/work?w=${encodeURIComponent(workSessionId)}`,
              );
            };
          } catch {
            // Without persistent deduplication or actual browser delivery, stay off.
            current.current.optedIn = false;
            setOptedIn(false);
            setDeliveryFailed(true);
            notify(current.current.failure, { severity: "warning" });
          }
        })
        .catch(() => {
          if (!mounted.current) return;
          current.current.optedIn = false;
          setOptedIn(false);
          setDeliveryFailed(true);
          notify(current.current.failure, { severity: "warning" });
        });
    },
    [workspaceId, slug, setOptedIn],
  );

  return {
    notifyCompletion,
    control: (
      <Tooltip content={label}>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={label}
          aria-pressed={enabled}
          aria-busy={pending}
          disabled={pending || permission === "loading"}
          onClick={() => void toggle()}
        >
          {enabled ? (
            <Bell className="size-4" />
          ) : (
            <BellOff className="size-4" />
          )}
        </Button>
      </Tooltip>
    ),
  };
}
