import { useTranslations } from "next-intl";
import { Loader } from "@/components/motion/loader";

export default function RootLoading() {
  const t = useTranslations("common");
  return (
    <div className="flex min-h-dvh items-center justify-center bg-background p-6 text-muted-foreground">
      <Loader variant="spinner" size={24} label={t("loading")} />
    </div>
  );
}
