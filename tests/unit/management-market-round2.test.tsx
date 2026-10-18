import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const io = vi.hoisted(() => ({ catalog: vi.fn(), client: vi.fn() }));
vi.mock("@/lib/market/pi-catalog-actions", () => ({
  piCatalogAction: io.catalog,
}));
vi.mock("@/lib/market/pi-client-actions", () => ({
  managePiPackageClientAction: io.client,
}));
vi.mock("next-intl", () => {
  const t = Object.assign((key: string) => key, {
    has: (key: string) => !key.includes("unknown"),
  });
  return { useTranslations: () => t, useLocale: () => "en" };
});
import {
  PiCatalogActionForm,
  PiCatalogImportForm,
  PiOfficialInstallForm,
  PiSourceEditor,
  PiRegistryPublishForm,
} from "@/components/dashboard/market/PiCatalogForms";
import {
  PiClientInstallForm,
  PiClientRevokeForm,
} from "@/components/dashboard/market/PiClientInstallForm";

const release = {
  id: "rel",
  version: 2,
  name: "Package",
  sourceVersion: null,
  checksum: "sha",
  requirements: [{ key: "search", name: "Search", tools: ["query", "read"] }],
};
const deployments = [
  { id: "dep", name: "Search server", tools: ["query", "read"] },
  { id: "partial", name: "Partial server", tools: ["query"] },
  { id: "unrelated", name: "Other server", tools: ["write"] },
];
const defaults = {
  search: { deploymentId: "dep", tools: ["query", "read", "removed"] },
};
function client(
  props: Partial<React.ComponentProps<typeof PiClientInstallForm>> = {},
) {
  return render(
    <PiClientInstallForm
      workspace="space"
      marketInstallId="install"
      release={release}
      deployments={deployments}
      defaults={defaults}
      {...props}
    />,
  );
}
function submit(label: string) {
  const button = screen.getByRole("button", { name: label });
  const form = button.closest("form");
  if (!form) throw new Error("Missing form");
  fireEvent.submit(form);
}
function data(mock: typeof io.catalog) {
  return mock.mock.calls.at(-1)?.[1] as FormData;
}
async function choose(label: string, option: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: label }));
  await user.click(await screen.findByRole("option", { name: option }));
}

describe("Pi catalog management forms", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    io.catalog.mockResolvedValue({ ok: true });
    io.client.mockResolvedValue({ ok: true });
  });
  it.each([
    ["install-official", true, "officialInstalled"],
    ["import", true, "submitted"],
    ["check", false, "checked"],
    ["update-source", false, "saved"],
  ] as const)(
    "reports %s and links committed resources",
    async (operation, capture, notice) => {
      render(
        <PiCatalogActionForm
          workspace="a b"
          operation={operation}
          label="Go"
          capture={capture}
          values={{ sourceId: "source" }}
        >
          <input aria-label="draft" name="draft" defaultValue="original" />
        </PiCatalogActionForm>,
      );
      fireEvent.change(screen.getByLabelText("draft"), {
        target: { value: "edited" },
      });
      io.catalog.mockResolvedValueOnce({ error: "unknown" });
      submit("Go");
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "errors.action_failed",
      );
      expect(screen.getByLabelText("draft")).toHaveValue("edited");
      io.catalog.mockResolvedValueOnce({
        ok: true,
        installId: "i /",
        listingId: "p /",
      });
      submit("Go");
      expect(await screen.findByRole("status")).toHaveTextContent(notice);
      expect(data(io.catalog).get("sourceId")).toBe("source");
      expect(data(io.catalog).get("workspace")).toBe("a b");
      expect(data(io.catalog).get("operation")).toBe(operation);
      expect(screen.getByRole("link", { name: "installed" })).toHaveAttribute(
        "href",
        "/app/a%20b/market/installed#install-i%20%2F",
      );
      expect(
        screen.getByRole("link", { name: "workspacePackages" }),
      ).toHaveAttribute(
        "href",
        "/app/a%20b/toolkits/pi-packages#package-p%20%2F",
      );
    },
  );
  it("retains fields on known action errors and prevents unsolicited resets", async () => {
    io.catalog.mockResolvedValue({ error: "not_authorized" });
    render(
      <PiOfficialInstallForm
        workspace="space"
        entry={{ name: "official", version: "1.2.3" }}
      />,
    );
    fireEvent.change(screen.getByLabelText("preciseVersion"), {
      target: { value: "2.0.0" },
    });
    fireEvent.reset(
      screen
        .getByLabelText("preciseVersion")
        .closest("form") as HTMLFormElement,
    );
    expect(screen.getByLabelText("preciseVersion")).toHaveValue("2.0.0");
    submit("installOfficial");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "errors.not_authorized",
    );
    expect(data(io.catalog).get("version")).toBe("2.0.0");
  });
  it("requires management permission and derives bounded import metadata", () => {
    const props = {
      workspace: "space",
      entry: {
        name: "@@ Example Package !!",
        source: "npm:pkg",
        description: "Description",
      },
      categories: [{ id: "cat", name: "Tools" }],
    };
    const view = render(<PiCatalogImportForm {...props} canManage={false} />);
    expect(screen.getByText("managerRequired")).toBeVisible();
    expect(screen.queryByLabelText("packageSource")).toBeNull();
    view.rerender(<PiCatalogImportForm {...props} canManage />);
    fireEvent.click(screen.getByText("reviewImport"));
    expect(screen.getByLabelText("slug")).toHaveValue("example-package");
    expect(screen.getByLabelText("name")).toHaveValue(props.entry.name);
    expect(screen.getByLabelText("summary")).toHaveValue("Description");
    expect(screen.getByLabelText("packageSource")).toBeRequired();
  });
  it("changes source authentication without rendering stale secrets", async () => {
    const user = userEvent.setup();
    render(
      <PiSourceEditor
        workspace="space"
        source={{
          id: "src",
          name: "Private",
          kind: "git",
          url: "https://example.test",
          hasCredentials: true,
        }}
      />,
    );
    expect(screen.queryByLabelText("sourceKind")).toBeNull();
    await choose("authentication", "bearer");
    expect(screen.getByLabelText("token")).toBeRequired();
    await user.type(screen.getByLabelText("token"), "secret");
    submit("saveSource");
    await waitFor(() => expect(io.catalog).toHaveBeenCalled());
    expect(data(io.catalog).get("token")).toBe("secret");
    await choose("authentication", "basic");
    expect(screen.queryByLabelText("token")).toBeNull();
    expect(screen.getByLabelText("username")).toBeRequired();
    expect(screen.getByLabelText("password")).toHaveAttribute(
      "type",
      "password",
    );
    await choose("authentication", "clearCredentials");
    expect(screen.queryByLabelText("username")).toBeNull();
    await user.click(screen.getByRole("checkbox", { name: "deleteConfirm" }));
    submit("deleteSource");
    await waitFor(() =>
      expect(data(io.catalog).get("operation")).toBe("delete-source"),
    );
  });
  it("creates sources and gates publishing on both prerequisites", async () => {
    const view = render(<PiSourceEditor workspace="space" />);
    expect(screen.getByLabelText("name")).toHaveValue("");
    expect(screen.getByRole("combobox", { name: "sourceKind" })).toBeVisible();
    view.unmount();
    const publish = render(
      <PiRegistryPublishForm workspace="space" sources={[]} releases={[]} />,
    );
    expect(screen.getByText("registryPrerequisites")).toBeVisible();
    publish.rerender(
      <PiRegistryPublishForm
        workspace="space"
        sources={[{ id: "src", name: "Registry" }]}
        releases={[]}
      />,
    );
    expect(screen.getByText("registryPrerequisites")).toBeVisible();
    publish.rerender(
      <PiRegistryPublishForm
        workspace="space"
        sources={[{ id: "src", name: "Registry" }]}
        releases={[{ id: "rel", label: "Release" }]}
      />,
    );
    expect(screen.getByLabelText("registryTag")).toHaveValue("latest");
    submit("publishRegistry");
    await waitFor(() => expect(io.catalog).toHaveBeenCalled());
    expect(data(io.catalog).get("operation")).toBe("registry-publish");
  });
});

describe("Pi client installation bindings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    io.client.mockResolvedValue({ ok: true });
  });
  it("filters obsolete default tools, changes clients and submits scoped bindings", async () => {
    const user = userEvent.setup();
    client();
    expect(screen.getByRole("checkbox", { name: "query" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "read" })).toBeChecked();
    await choose("client", "codex");
    expect(screen.getByText("omittedBehavior")).toBeVisible();
    await user.type(screen.getByLabelText("deviceLabel"), "Laptop");
    await user.click(
      screen.getByRole("checkbox", { name: "createConfirmation" }),
    );
    submit("create");
    expect(await screen.findByRole("status")).toHaveTextContent("updated");
    expect(data(io.client).get("operation")).toBe("create");
    expect(data(io.client).get("client")).toBe("codex");
    expect(JSON.parse(String(data(io.client).get("bindings")))).toEqual({
      search: { deploymentId: "dep", tools: ["query", "read"] },
    });
  });
  it("invalidates selections when deployment changes and blocks unavailable tools", async () => {
    const user = userEvent.setup();
    client({ defaults: {} });
    expect(screen.getByRole("button", { name: "create" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "query" })).toBeDisabled();
    await choose("deployment", "Partial server");
    expect(screen.getByRole("checkbox", { name: "read" })).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: "query" }));
    expect(screen.getByRole("button", { name: "create" })).toBeEnabled();
    await user.click(screen.getByRole("checkbox", { name: "query" }));
    expect(screen.getByRole("button", { name: "create" })).toBeDisabled();
  });
  it("requires every tool for workspace defaults and preserves existing installation identity", async () => {
    const user = userEvent.setup();
    client({
      workspaceBindings: true,
      existing: {
        id: "device",
        client: "hermes",
        bindings: { search: { deploymentId: "dep", tools: ["query"] } },
      },
    });
    expect(screen.queryByLabelText("deviceLabel")).toBeNull();
    expect(screen.getByText("workspaceBindingsRequired")).toBeVisible();
    await user.click(screen.getByRole("checkbox", { name: "read" }));
    await user.click(
      screen.getByRole("checkbox", { name: "permissionConfirmation" }),
    );
    submit("saveWorkspaceBindings");
    expect(await screen.findByRole("status")).toHaveTextContent(
      "workspaceBindingsSaved",
    );
    expect(data(io.client).get("operation")).toBe("workspace-bindings");
    expect(data(io.client).get("installationId")).toBe("device");
  });
  it.each(["unknown", "not_authorized"])(
    "surfaces %s update errors",
    async (error) => {
      io.client.mockResolvedValue({ error });
      client({ existing: { id: "device", client: "pi", bindings: defaults } });
      submit("applyUpdate");
      expect(await screen.findByRole("alert")).toHaveTextContent(
        error === "unknown"
          ? "errors.pi_client_action_failed"
          : "errors.not_authorized",
      );
    },
  );
  it("reveals and permanently dismisses a one-time private configuration", async () => {
    const user = userEvent.setup();
    io.client.mockResolvedValue({
      privateConfig: { installationId: "device", token: "private-token" },
    });
    client();
    submit("create");
    await screen.findByText("oneTimeWarning");
    expect(screen.queryByText(/private-token/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "revealConfig" }));
    expect(
      screen.getByRole("region", { name: "privateConfig" }),
    ).toHaveTextContent("private-token");
    await user.click(screen.getByRole("button", { name: "hideConfig" }));
    expect(screen.queryByRole("region", { name: "privateConfig" })).toBeNull();
    const create = vi.fn(() => "blob:private");
    const revoke = vi.fn();
    vi.stubGlobal(
      "URL",
      Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }),
    );
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});
    await user.click(screen.getByRole("button", { name: "downloadConfig" }));
    expect(create).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledWith("blob:private");
    click.mockRestore();
    await user.click(screen.getByRole("button", { name: "dismissConfig" }));
    expect(screen.getByRole("status")).toHaveTextContent("configDismissed");
    expect(screen.queryByRole("button", { name: "revealConfig" })).toBeNull();
  });
});

describe("Pi client credential revocation", () => {
  it("submits the installation identity and displays failures before success", async () => {
    io.client
      .mockResolvedValueOnce({ error: "not_authorized" })
      .mockResolvedValueOnce({ ok: true });
    render(<PiClientRevokeForm workspace="space" installationId="device" />);
    submit("revoke");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "errors.pi_client_action_failed",
    );
    submit("revoke");
    expect(await screen.findByRole("status")).toHaveTextContent("revoked");
    expect(Object.fromEntries(data(io.client))).toEqual({
      workspace: "space",
      installationId: "device",
      operation: "revoke",
    });
  });
});
