import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { ForgotPasswordForm } from "@/components/auth/PasswordRecoveryForms";
import { safeRelativePath } from "@/lib/auth/safe-redirect";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth");
  return {
    title: t("forgotPasswordMetadata"),
    robots: { index: false, follow: true },
  };
}

export default async function ForgotPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const next = safeRelativePath((await searchParams).next) ?? undefined;
  return <ForgotPasswordForm next={next} />;
}
