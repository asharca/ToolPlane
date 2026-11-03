import { getLocale } from "next-intl/server";
import { ButtonLink } from "@/components/motion/button";
import { getMarketingContent } from "@/lib/marketing/content";

export async function HomeView() {
  const { home, navigation, capabilities } = getMarketingContent(
    await getLocale(),
  );
  return (
    <div className="mx-auto max-w-5xl px-6 py-20">
      <section className="py-12">
        <h1 className="text-5xl font-semibold tracking-tight">
          {home.eyebrow}
        </h1>
        <p className="mt-6 max-w-3xl text-xl text-muted-foreground">
          {home.description}
        </p>
        <div className="mt-10">
          <ButtonLink href="/app">{navigation.openConsole}</ButtonLink>
        </div>
      </section>
      {Object.entries(capabilities).map(([key, capability]) => (
        <section
          key={key}
          id={key}
          className="scroll-mt-24 border-t border-border py-14"
        >
          <p className="text-sm text-muted-foreground">{capability.eyebrow}</p>
          <h2 className="mt-3 text-3xl font-semibold">{capability.title}</h2>
          <p className="mt-4 text-lg text-muted-foreground">
            {capability.description}
          </p>
          <div className="mt-8 grid gap-6 sm:grid-cols-3">
            {capability.highlights.map((highlight) => (
              <div key={highlight.title}>
                <h3 className="font-semibold">{highlight.title}</h3>
                <p className="mt-2 text-sm text-muted-foreground">
                  {highlight.description}
                </p>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
