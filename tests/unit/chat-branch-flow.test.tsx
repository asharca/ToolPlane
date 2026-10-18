import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode, ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ChatBranchPanel,
  type ChatBranchNode,
} from "@/components/dashboard/chat/ChatBranchFlow";

// Render the graph's real node content without depending on browser canvas/SVG measurements.
vi.mock("@xyflow/react", () => ({
  Position: { Top: "top", Bottom: "bottom" },
  MarkerType: { ArrowClosed: "arrow" },
  Handle: () => null,
  Background: () => null,
  Controls: () => null,
  MiniMap: () => null,
  ReactFlow: ({
    nodes,
    nodeTypes,
    onNodeClick,
    children,
  }: {
    nodes: { id: string; data: unknown }[];
    nodeTypes: Record<string, ComponentType<{ data: unknown }>>;
    onNodeClick: (event: unknown, node: { id: string }) => void;
    children: ReactNode;
  }) => {
    const Node = nodeTypes.chatBranch;
    return (
      <section aria-label="Branch graph">
        {nodes.map((node) => (
          <div key={node.id}>
            <button type="button" onClick={(event) => onNodeClick(event, node)}>
              Go to {node.id}
            </button>
            <Node data={node.data} />
          </div>
        ))}
        {children}
      </section>
    );
  },
}));

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(900);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const node = (
  id: string,
  overrides: Partial<ChatBranchNode> = {},
): ChatBranchNode => ({
  id,
  parentId: null,
  role: "assistant",
  status: "success",
  modelId: "model-a",
  createdAt: "2026-01-01T00:00:00Z",
  preview: `Answer ${id}`,
  active: true,
  awaitingInput: false,
  ...overrides,
});
function show(
  nodes: ChatBranchNode[],
  overrides: Partial<Parameters<typeof ChatBranchPanel>[0]> = {},
) {
  const actions = {
    onStart: vi.fn(),
    onDelete: vi.fn(),
    onSelect: vi.fn(),
    onClose: vi.fn(),
    onMaximize: vi.fn(),
  };
  const props = {
    branch: {
      nodes,
      navigation: [],
      branchCount: 2,
      activeMessageId: "answer",
    },
    busy: false,
    ...actions,
    ...overrides,
  };
  return { ...actions, ...render(<ChatBranchPanel {...props} />) };
}

describe("conversation branch graph", () => {
  it("distinguishes persisted states and offers branch actions only for appropriate messages", async () => {
    const { onStart, onDelete, onSelect } = show([
      node("question", {
        role: "user",
        modelId: null,
        preview: "Original question",
      }),
      node("answer", { parentId: "question" }),
      node("failed", {
        parentId: "question",
        status: "failed",
        active: false,
        createdAt: "invalid",
      }),
      node("cancelled", {
        parentId: "answer",
        status: "cancelled",
        active: false,
      }),
      node("pending", { parentId: "answer", status: "pending", active: false }),
      node("empty", {
        parentId: "answer",
        awaitingInput: true,
        preview: "",
        active: false,
      }),
      node("orphan", {
        parentId: "missing",
        role: "user",
        status: "success",
        active: false,
      }),
    ]);
    await screen.findByRole("region", { name: "Branch graph" });
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByText("Stopped")).toBeInTheDocument();
    expect(screen.getByText("Generating")).toBeInTheDocument();
    expect(screen.getByText("New branch")).toBeInTheDocument();
    const answer = document.querySelector('[data-message-id="answer"]');
    const empty = document.querySelector('[data-message-id="empty"]');
    if (!(answer instanceof HTMLElement) || !(empty instanceof HTMLElement))
      throw new Error("Branch nodes missing");
    expect(answer).toHaveAttribute("data-active-path", "true");
    expect(empty).toHaveAttribute("data-active-path", "false");
    fireEvent.click(
      within(answer).getByRole("button", { name: "Start a new branch" }),
    );
    expect(onStart).toHaveBeenCalledWith("answer");
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.click(
      within(empty).getByRole("button", { name: "Delete empty branch" }),
    );
    expect(onDelete).toHaveBeenCalledWith("empty");
    fireEvent.click(screen.getByRole("button", { name: "Go to failed" }));
    expect(onSelect).toHaveBeenCalledWith("failed");
    expect(
      document.querySelector('[data-message-id="failed"] time'),
    ).toHaveTextContent("");
  });

  it("blocks navigation and destructive actions while mutations are pending", async () => {
    const { onSelect, onStart, onDelete } = show(
      [node("draft", { awaitingInput: true })],
      { busy: true },
    );
    await screen.findByRole("region", { name: "Branch graph" });
    expect(
      screen.getByRole("button", { name: "Start a new branch" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Delete empty branch" }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Go to draft" }));
    expect(onSelect).not.toHaveBeenCalled();
    expect(onStart).not.toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("supports maximizing, restoring and dismissing the panel independently of message selection", async () => {
    const { onMaximize, onClose, rerender } = show([], { canMaximize: true });
    expect(
      screen.queryByRole("region", { name: "Branch graph" }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Maximize branch view" }),
    );
    expect(onMaximize).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledOnce();
    rerender(
      <ChatBranchPanel
        branch={{
          activeMessageId: null,
          branchCount: 0,
          navigation: [],
          nodes: [],
        }}
        busy={false}
        canMaximize
        maximized
        onMaximize={onMaximize}
        onStart={vi.fn()}
        onDelete={vi.fn()}
        onSelect={vi.fn()}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Restore branch view" }),
    );
    expect(onMaximize).toHaveBeenCalledTimes(2);
    expect(
      screen.queryByRole("button", { name: "Close" }),
    ).not.toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Conversation branches" }),
      ).toBeInTheDocument(),
    );
  });
});
