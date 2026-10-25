import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  PiPackageComposeForm,
  PiPackagePublishForm,
} from "@/components/dashboard/market/SkillPublishForm";
import {
  previewPiPackageSourceAction,
  publishAssembledPiPackageReleaseAction,
  publishPiPackageReleaseAction,
} from "@/lib/market/actions";

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("@/lib/market/actions", () => ({
  previewPiPackageSourceAction: vi.fn(),
  publishPiPackageReleaseAction: vi.fn(),
  publishAssembledPiPackageReleaseAction: vi.fn(),
  previewAssembledPiPackageAction: vi.fn(),
  publishAssistantReleaseAction: vi.fn(),
  publishMcpReleaseAction: vi.fn(),
  publishSkillReleaseAction: vi.fn(),
}));

describe("Pi package composition", () => {
  it("preserves standalone assembly files and edited metadata while correcting a refused submission", async () => {
    const user = userEvent.setup();
    vi.mocked(publishAssembledPiPackageReleaseAction)
      .mockResolvedValueOnce({ error: "invalid_categories" })
      .mockResolvedValueOnce({ ok: true });
    render(
      <PiPackageComposeForm
        workspace="acme"
        canPublish
        categories={[{ id: "category", name: "Research" }]}
        inline
        resource={{
          id: "source",
          name: "Research",
          slug: "research",
          description: "Initial summary",
        }}
        options={{ skills: [], deployments: [] }}
      />,
    );
    const upload = screen.getByLabelText<HTMLInputElement>(
      "Standalone Theme JSON files",
    );
    const theme = new File(['{"name":"night"}'], "night.json", {
      type: "application/json",
    });
    await user.upload(upload, theme);
    const summary = screen.getByLabelText("listingSummary");
    await user.clear(summary);
    await user.type(summary, "Keep the edited summary");
    await user.click(
      screen.getByRole("button", { name: "savePrivatePackage" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "piInvalidCategories",
    );
    expect(upload.files?.[0]).toBe(theme);
    expect(summary).toHaveValue("Keep the edited summary");
    await user.click(screen.getByRole("checkbox", { name: "Research" }));
    await user.click(
      screen.getByRole("button", { name: "savePrivatePackage" }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "privatePackageSavedPendingReview",
    );
  });
  it("retains the selected ZIP and editable values after refusal, and invalidates a stale preview", async () => {
    const user = userEvent.setup();
    const digest = "a".repeat(64);
    vi.mocked(previewPiPackageSourceAction).mockResolvedValueOnce({
      preview: {
        sourceDigest: digest,
        refPin: `zip:sha256:${digest}`,
        source: {
          kind: "zip",
          requested: `zip:sha256:${digest}`,
          sha256: digest,
        },
        name: "prompt-only",
        version: "1.0.0",
        runtime: {
          kind: "pi-sdk",
          piVersion: "0.87.1",
          nodeMajor: 24,
          platform: "any",
          arch: "any",
        },
        resources: {
          extensions: [],
          skills: [],
          prompts: ["prompt.md"],
          themes: [],
        },
        fileCount: 1,
        totalBytes: 10,
        files: [{ path: "prompt.md", type: "file", size: 10 }],
        mcpRequirements: [],
        metadata: { description: null, license: null, keywords: [] },
      },
    });
    vi.mocked(publishPiPackageReleaseAction)
      .mockResolvedValueOnce({ error: "invalid_categories" })
      .mockResolvedValueOnce({ error: "source_changed" });
    render(
      <PiPackagePublishForm
        workspace="acme"
        canPublish
        categories={[{ id: "category", name: "Research" }]}
        inline
      />,
    );
    await user.selectOptions(
      screen.getByRole("combobox", { name: "piSourceType" }),
      "zip",
    );
    const archive = new File(["ZIP fixture"], "prompt-only.zip", {
      type: "application/zip",
    });
    const upload = screen.getByLabelText<HTMLInputElement>("zipArchive");
    await user.upload(upload, archive);
    await user.click(
      screen.getByRole("checkbox", { name: "piExecutableConsent" }),
    );
    await user.click(screen.getByRole("button", { name: "piPreviewAction" }));
    const submit = screen.getByRole("button", { name: "savePrivatePackage" });
    await waitFor(() => expect(submit).toBeEnabled());
    await user.type(screen.getByLabelText("listingName"), "Prompt package");
    await user.type(screen.getByLabelText("listingSlug"), "prompt-package");
    await user.type(
      screen.getByLabelText("listingSummary"),
      "Keep this summary",
    );
    const form = upload.form;
    if (!form) throw new Error("Capture form missing");
    // user-event supplies a DOM-level FileList, but JSDOM's required-file
    // validator reads its unchanged internal list. Exercise error recovery
    // directly; keep real selected-file and stale-preview assertions below.
    fireEvent.submit(form);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "piInvalidCategories",
    );
    expect(upload.files?.[0]).toBe(archive);
    expect(screen.getByLabelText("listingName")).toHaveValue("Prompt package");
    expect(screen.getByLabelText("listingSlug")).toHaveValue("prompt-package");
    expect(screen.getByLabelText("listingSummary")).toHaveValue(
      "Keep this summary",
    );
    expect(submit).toBeEnabled();
    await user.click(screen.getByRole("checkbox", { name: "Research" }));
    fireEvent.submit(form);
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("piSourceChanged"),
    );
    await waitFor(() => expect(submit).toBeDisabled());
    expect(upload.files?.[0]).toBe(archive);
    expect(screen.getByLabelText("listingSummary")).toHaveValue(
      "Keep this summary",
    );
    expect(upload.form?.querySelector('[name="sourceDigest"]')).toBeNull();
  });
  it.each([
    [false, false, "privatePackageSavedPendingReview"],
    [false, true, "privatePackageSaved"],
    [true, false, "releaseSubmitted"],
  ] as const)(
    "reports the actual visibility and trust outcome (public=%s, consent=%s)",
    async (publicListing, consent, outcome) => {
      const user = userEvent.setup();
      vi.mocked(publishAssembledPiPackageReleaseAction).mockResolvedValueOnce({
        ok: true,
      });
      render(
        <PiPackageComposeForm
          workspace="acme"
          canPublish
          categories={[]}
          inline
          resource={{
            id: "source",
            name: "Research",
            slug: "research",
            description: "Research capabilities",
          }}
          options={{ skills: [], deployments: [] }}
        />,
      );
      expect(
        screen.getByRole("button", { name: "savePrivatePackage" }),
      ).toBeInTheDocument();
      if (publicListing) {
        await user.click(
          screen.getByRole("checkbox", { name: "piVisibilityPublic" }),
        );
      }
      if (consent) {
        await user.click(
          screen.getByRole("checkbox", { name: "piExecutableConsent" }),
        );
      }
      await user.click(
        screen.getByRole("button", {
          name: publicListing ? "submitForReview" : "savePrivatePackage",
        }),
      );
      expect(await screen.findByRole("status")).toHaveTextContent(outcome);
    },
  );
  it.each([
    [
      "pi_package_executable_confirmation_required",
      "piExecutableConfirmationRequired",
    ],
    ["not_authorized", "publishErrorUnauthorized"],
  ])(
    "shows distinct ZIP preview feedback for %s",
    async (error, expectedMessage) => {
      const user = userEvent.setup();
      vi.mocked(previewPiPackageSourceAction).mockResolvedValueOnce({ error });
      render(
        <PiPackagePublishForm
          workspace="acme"
          canPublish
          categories={[]}
          inline
        />,
      );
      expect(
        screen.getByRole("button", { name: "savePrivatePackage" }),
      ).toBeDisabled();
      await user.selectOptions(
        screen.getByRole("combobox", { name: "piSourceType" }),
        "zip",
      );
      await user.upload(
        screen.getByLabelText("zipArchive"),
        new File(["ZIP fixture"], "package.zip", { type: "application/zip" }),
      );
      expect(
        screen.getByRole("checkbox", { name: "piExecutableConsent" }),
      ).not.toBeChecked();
      await user.click(screen.getByRole("button", { name: "piPreviewAction" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        expectedMessage,
      );
      expect(
        screen.getByRole("checkbox", { name: "piExecutableConsent" }),
      ).not.toBeChecked();
    },
  );
  it("prefills Toolkit resources while keeping the new package selection editable and independent", async () => {
    const user = userEvent.setup();
    render(
      <PiPackageComposeForm
        workspace="acme"
        canPublish
        categories={[]}
        resource={{
          id: "toolkit",
          name: "Research",
          slug: "research",
          description: null,
        }}
        options={{
          packages: [{ id: "release-fixed", name: "Existing @ 1.0.0" }],
          skills: [
            { id: "included", name: "Included skill", selected: true },
            { id: "other", name: "Other skill" },
          ],
          deployments: [
            {
              id: "search-mcp",
              name: "Search MCP",
              tools: ["search", "lookup"],
              selected: true,
            },
            { id: "write-mcp", name: "Write MCP", tools: ["write"] },
          ],
        }}
      />,
    );
    await user.click(screen.getByRole("button", { name: "piComposeTitle" }));
    const included = await screen.findByRole("checkbox", {
      name: "Included skill",
    });
    expect(included).toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: "Other skill" }),
    ).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "search" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "lookup" })).toBeChecked();
    await user.click(
      screen.getByRole("checkbox", { name: "Existing @ 1.0.0" }),
    );
    expect(
      screen.getByLabelText("Standalone Theme JSON files"),
    ).toHaveAttribute("accept", ".json");
    expect(screen.getByRole("checkbox", { name: "write" })).not.toBeChecked();
    await user.click(screen.getByRole("checkbox", { name: "lookup" }));
    const form = included.closest("form");
    if (!form) throw new Error("Composition form missing");
    const submitted = new FormData(form);
    expect(submitted.getAll("packageReleaseIds")).toEqual(["release-fixed"]);
    expect(submitted.getAll("installedSkillIds")).toEqual(["included"]);
    expect(
      submitted.getAll("mcpTools").map((value) => JSON.parse(String(value))),
    ).toEqual([["search-mcp", "search"]]);
    expect(submitted.get("packageName")).toBe("research");
    expect(submitted.get("name")).toBe("Research");
    expect(submitted.get("listingId")).toBe("");
    expect(submitted.has("toolkitId")).toBe(false);
  });
});
