import { useTranslations } from "next-intl";
import { Loader } from "@/components/motion/loader";

export default function WorkspaceLoading() {
  const t = useTranslations("common");
  return (
    <div className="flex min-h-[50dvh] flex-1 items-center justify-center p-6 text-muted-foreground">
      <Loader variant="spinner" size={24} label={t("loading")} />
    </div>
  );
}
