import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PluginReadme } from "@/components/dashboard/plugins/PluginReadme";

const commit = "c5fb840be966b26f21e78d8c18f396dfce6b31f7";
const sourceUrl = `https://github.com/asharca/toolplane-plugins/blob/${commit}/plugins/ocrplane-cli/README.md`;

function render(text: string) {
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(
    <PluginReadme text={text} sourceUrl={sourceUrl} />,
  );
  return container;
}

describe("version-pinned plugin README", () => {
  it("resolves bare and dot-relative package links before URL hardening", () => {
    const page = render(
      "[Skill](skills/ocrplane-cli/SKILL.md)\n\n![Image](./image.png)",
    );
    expect(page.querySelector("a")?.href).toBe(
      `https://github.com/asharca/toolplane-plugins/blob/${commit}/plugins/ocrplane-cli/skills/ocrplane-cli/SKILL.md`,
    );
    expect(page.querySelector("img")?.src).toBe(
      `https://raw.githubusercontent.com/asharca/toolplane-plugins/${commit}/plugins/ocrplane-cli/image.png`,
    );
  });

  it("does not allow package documentation to mount executable HTML or active URLs", () => {
    const page = render(
      '[Bad](javascript:alert(1))\n\n<script>window.__readmeExecuted=true</script>\n\n<iframe src="https://example.com"></iframe>\n\n<img src="data:image/svg+xml,test" onerror="alert(1)" />',
    );
    expect(page.querySelector("script,iframe,[onerror]")).toBeNull();
    expect(
      page.querySelector('a[href^="javascript:"],img[src^="data:"]'),
    ).toBeNull();
  });
});
