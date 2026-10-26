// @vitest-environment node
import { describe, expect, it } from "vitest";

import { POST } from "@/app/api/v1/workspaces/[slug]/sandboxes/hermes-import/route";

describe("POST /api/v1/workspaces/[slug]/sandboxes/hermes-import", () => {
  it("returns 410 Gone because archive imports were removed", async () => {
    const response = await POST();

    expect(response.status).toBe(410);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      error:
        "Hermes archive import has been removed. Create a sandbox from an image or connect a machine instead.",
    });
  });
});
