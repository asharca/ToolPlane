import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { MarketInstallReleaseDiff } from "@/lib/market/install-release-diff";

const mocks = vi.hoisted(() => ({ update: vi.fn(), fetch: vi.fn() }));
vi.mock("next-intl", () => {
  const t = (key: string) => key;
  return { useTranslations: () => t };
});
vi.mock("@/lib/market/actions", () => ({
  updateMarketInstallAction: mocks.update,
}));
import { MarketVersionChangeForm } from "@/components/dashboard/market/MarketVersionChangeForm";

const diff: MarketInstallReleaseDiff = {
  from: { releaseId: "current", version: 1 },
  to: { releaseId: "target", version: 2 },
  files: {
    items: [{ path: "package/index.ts", status: "changed" }],
    total: 1,
    page: 1,
    pageSize: 50,
    counts: { added: 0, removed: 0, changed: 1 },
  },
  permissions: {
    before: { requirements: [], requiredEnvironment: [], transport: null },
    after: { requirements: [], requiredEnvironment: [], transport: null },
  },
  compatibility: { before: null, after: null },
  configurationChanged: false,
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", mocks.fetch);
});
afterEach(() => vi.unstubAllGlobals());
it("requires an exact approved comparison and acknowledgement before the separate confirmation can submit", async () => {
  mocks.fetch.mockResolvedValue({ ok: true, json: async () => diff });
  const user = userEvent.setup();
  render(
    <MarketVersionChangeForm
      workspace="owned"
      installId="install"
      currentReleaseId="current"
      targetReleaseId="target"
      targetVersion={2}
      kind="pi-package"
    />,
  );
  expect(
    screen.getByRole("button", { name: "switchToVersion" }),
  ).toBeDisabled();
  await user.click(screen.getByRole("button", { name: /compareRelease/ }));
  await screen.findByText("package/index.ts");
  expect(
    screen.getByRole("button", { name: "switchToVersion" }),
  ).toBeDisabled();
  await user.click(
    screen.getByRole("checkbox", { name: "comparisonAcknowledgement" }),
  );
  await user.click(screen.getByRole("button", { name: "switchToVersion" }));
  await screen.findByText("piVersionImpact");
  expect(mocks.update).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "switchToVersion" }));
  expect(mocks.update).toHaveBeenCalledOnce();
});
it("does not enable update from a successful but stale version comparison", async () => {
  mocks.fetch.mockResolvedValue({
    ok: true,
    json: async () => ({
      ...diff,
      from: { releaseId: "concurrently-updated", version: 3 },
    }),
  });
  const user = userEvent.setup();
  render(
    <MarketVersionChangeForm
      workspace="owned"
      installId="install"
      currentReleaseId="current"
      targetReleaseId="target"
      targetVersion={2}
      kind="skill"
    />,
  );
  await user.click(screen.getByRole("button", { name: /compareRelease/ }));
  await screen.findByRole("alert");
  expect(
    screen.getByRole("checkbox", { name: "comparisonAcknowledgement" }),
  ).toBeDisabled();
  expect(
    screen.getByRole("button", { name: "switchToVersion" }),
  ).toBeDisabled();
  expect(mocks.update).not.toHaveBeenCalled();
});
