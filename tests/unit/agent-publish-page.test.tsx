import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`redirect:${path}`);
  },
}));

import AgentPublishPage from "@/app/app/[workspace]/agents/[agentId]/publish/page";

describe("legacy agent publication route", () => {
  it("redirects to the standard package importer", async () => {
    await expect(
      AgentPublishPage({
        params: Promise.resolve({ workspace: "acme", agentId: "agent-1" }),
      }),
    ).rejects.toThrow("redirect:/app/acme/market/import?type=pi");
  });
});
