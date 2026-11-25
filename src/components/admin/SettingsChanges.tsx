"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { AlertTriangle } from "lucide-react";
import { ConfirmActionDialog } from "@/components/dashboard/ConversationUxPrimitives";

export function SettingsChanges({ children }: { children: ReactNode }) {
  const t = useTranslations("adminOps");
  const commonT = useTranslations("common");
  const router = useRouter();
  const root = useRef<HTMLDivElement>(null);
  const initialValues = useRef(new WeakMap<Element, string | boolean>());
  const [dirty, setDirty] = useState(false);
  const [pendingHref, setPendingHref] = useState<string | null>(null);
  const hasChanges = useCallback(
    () =>
      Boolean(
        root.current &&
          Array.from(
            root.current.querySelectorAll<
              HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
            >("input:not([type=hidden]), textarea, select"),
          ).some((field) => {
            const value =
              field instanceof HTMLInputElement &&
              ["checkbox", "radio"].includes(field.type)
                ? field.checked
                : field.value;
            if (!initialValues.current.has(field)) {
              initialValues.current.set(field, value);
              return false;
            }
            return initialValues.current.get(field) !== value;
          }),
      ),
    [],
  );
  const refresh = () => setDirty(hasChanges());

  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => {
      if (hasChanges()) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    const navigate = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const link =
        event.target instanceof Element
          ? event.target.closest<HTMLAnchorElement>("a[href]")
          : null;
      if (!link || link.target === "_blank" || link.hasAttribute("download"))
        return;
      const target = new URL(link.href, window.location.href);
      if (
        target.pathname === location.pathname &&
        target.search === location.search
      )
        return;
      if (hasChanges()) {
        event.preventDefault();
        event.stopImmediatePropagation();
        setPendingHref(
          target.origin === location.origin
            ? `${target.pathname}${target.search}${target.hash}`
            : target.href,
        );
      }
    };
    window.addEventListener("beforeunload", unload);
    document.addEventListener("click", navigate, true);
    return () => {
      window.removeEventListener("beforeunload", unload);
      document.removeEventListener("click", navigate, true);
    };
  }, [hasChanges]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: React children changes can remount saved form sections; recheck their committed DOM values without resetting failed drafts.
  useLayoutEffect(() => {
    // The wrapper must recalculate dirty state after server-rendered section changes.
    setDirty(hasChanges());
  }, [children, hasChanges]);

  // Successful saves remount their section by audit id; failed actions must keep the draft.
  return (
    <>
      <div
        ref={root}
        onInput={refresh}
        onChange={refresh}
        onReset={(event) => {
          event.preventDefault();
          requestAnimationFrame(refresh);
        }}
        className="space-y-6"
      >
        {dirty ? (
          <p
            role="status"
            className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-background py-3 text-sm text-muted-foreground"
          >
            <AlertTriangle className="size-4" />
            {t("unsaved")}
          </p>
        ) : null}
        {children}
      </div>
      <ConfirmActionDialog
        open={pendingHref !== null}
        title={commonT("unsavedChanges")}
        description={t("leaveUnsaved")}
        confirmLabel={commonT("confirm")}
        cancelLabel={commonT("cancel")}
        destructive
        onClose={() => setPendingHref(null)}
        onConfirm={() => {
          const href = pendingHref;
          setPendingHref(null);
          if (!href) return;
          if (href.startsWith("/")) router.push(href);
          else window.location.assign(href);
        }}
      />
    </>
  );
}
