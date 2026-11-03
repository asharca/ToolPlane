"use client";

import { useActionState, type ReactNode } from "react";
import { useTranslations } from "next-intl";

/** These creation actions redirect on success; a normal return is a refusal. */
export function McpConnectionCreateForm({
  action,
  children,
  className,
}: {
  action: (form: FormData) => Promise<unknown>;
  children: ReactNode;
  className?: string;
}) {
  const t = useTranslations("console.mcp");
  const [failed, submit] = useActionState<boolean, FormData>(
    async (_previous, form) => {
      await action(form);
      return true;
    },
    false,
  );
  return (
    <form action={submit} className={className}>
      {children}
      {failed ? (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {t("connectionCreateFailed")}
        </p>
      ) : null}
    </form>
  );
}
