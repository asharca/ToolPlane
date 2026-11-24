import { InterceptedSettingsProvider } from "@/components/dashboard/SettingsModal";

export default function InterceptedPersonalSettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <InterceptedSettingsProvider>{children}</InterceptedSettingsProvider>;
}
