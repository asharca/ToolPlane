import { DocsShell } from "./docs-shell";
import { getDocs } from "@/lib/docs";
import "./docs.css";

export default async function Layout({
  children,
}: {
  children: React.ReactNode;
}) {
  const docs = await getDocs();
  return (
    <DocsShell
      docs={docs.map(({ url, title, language, category, topic }) => ({
        url,
        title,
        language,
        category,
        topic,
      }))}
    >
      {children}
    </DocsShell>
  );
}
