import { InterceptedSettingsProvider } from "@/components/dashboard/SettingsModal";

export default function InterceptedAgentsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <InterceptedSettingsProvider>{children}</InterceptedSettingsProvider>;
}
