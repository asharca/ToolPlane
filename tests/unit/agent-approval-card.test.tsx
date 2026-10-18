import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type * as MotionReact from "motion/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApprovalCard } from "@/components/agents/approval-card";
import type {
  ApprovalCardQuestion,
  ApprovalCardStatus,
} from "@/components/agents/approval-card";
import { AgentProgress } from "@/components/agents/loading-states/agent-progress";

vi.mock("motion/react", async (importOriginal) => ({
  ...(await importOriginal<typeof MotionReact>()),
  useReducedMotion: () => true,
}));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const questions: ApprovalCardQuestion[] = [
  {
    id: "destination",
    title: "Where should it run?",
    description: "Choose an environment",
    autoAdvance: false,
    allowCustom: true,
    options: [
      { value: "test", label: "Test environment" },
      { value: "prod", label: "Production", disabled: true },
    ],
  },
  {
    id: "features",
    title: "Choose features",
    multiple: true,
    allowCustom: true,
    options: [
      { value: "logs", label: "Logging" },
      { value: "metrics", label: "Metrics" },
    ],
  },
];

describe("approval card decisions", () => {
  it("offers independent approve, reject, change-request and dismiss actions, and disables decisions while submitting", () => {
    const approve = vi.fn(),
      reject = vi.fn(),
      changes = vi.fn(),
      dismiss = vi.fn();
    const props = {
      onApprove: approve,
      onReject: reject,
      onRequestChanges: changes,
      onDismiss: dismiss,
    };
    const { rerender } = render(
      <ApprovalCard {...props} description="Review the deployment">
        Deployment details
      </ApprovalCard>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    fireEvent.click(screen.getByRole("button", { name: "Request changes" }));
    expect(approve).toHaveBeenCalledOnce();
    expect(reject).toHaveBeenCalledOnce();
    expect(changes).toHaveBeenCalledOnce();
    rerender(<ApprovalCard {...props} status="submitting" />);
    for (const name of ["Approve", "Reject", "Request changes"]) {
      expect(screen.getByRole("button", { name })).toBeDisabled();
      fireEvent.click(screen.getByRole("button", { name }));
    }
    expect(approve).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(dismiss).toHaveBeenCalledOnce();
  });

  it.each([
    ["approved", "Approved"],
    ["rejected", "Rejected"],
    ["changes-requested", "Changes requested"],
    ["answered", "Response submitted"],
  ] as const)(
    "makes completed %s decisions noninteractive and displays their outcome",
    (status, label) => {
      const { rerender } = render(
        <ApprovalCard status={status} onReject={vi.fn()} />,
      );
      expect(
        screen.queryByRole("button", { name: "Approve" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Reject" }),
      ).not.toBeInTheDocument();
      expect(screen.getAllByText(label)).toHaveLength(2);
      rerender(
        <ApprovalCard
          status={status as ApprovalCardStatus}
          result="Saved decision"
        />,
      );
      expect(screen.getByText("Saved decision")).toBeInTheDocument();
    },
  );

  it("requires an answer, preserves answers while moving backward, and submits multi-select plus custom responses", async () => {
    const submit = vi.fn();
    render(<ApprovalCard questions={questions} onSubmit={submit} />);
    expect(
      screen.getByRole("button", { name: "Previous question" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Next question" }),
    ).toBeDisabled();
    expect(screen.getByRole("radio", { name: "Production" })).toBeDisabled();
    fireEvent.click(screen.getByRole("radio", { name: "Test environment" }));
    fireEvent.click(screen.getByRole("button", { name: "Next question" }));
    await screen.findByRole("checkbox", { name: "Logging" });
    fireEvent.click(screen.getByRole("checkbox", { name: "Logging" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Metrics" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Logging" }));
    fireEvent.change(screen.getByPlaceholderText("Add another response…"), {
      target: { value: "Tracing" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Previous question" }));
    await waitFor(() =>
      expect(
        screen.getByRole("radio", { name: "Test environment" }),
      ).toBeChecked(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Next question" }));
    await waitFor(() =>
      expect(screen.getByRole("checkbox", { name: "Metrics" })).toBeChecked(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Submit response" }));
    expect(submit).toHaveBeenCalledWith({
      destination: { selected: ["test"], custom: "" },
      features: { selected: ["metrics"], custom: "Tracing" },
    });
  });

  it("single-answer custom text replaces an option and whitespace alone cannot be submitted", () => {
    const changed = vi.fn(),
      submit = vi.fn();
    render(
      <ApprovalCard
        questions={[questions[0]]}
        onAnswersChange={changed}
        onSubmit={submit}
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: "Test environment" }));
    fireEvent.change(screen.getByPlaceholderText("Add another response…"), {
      target: { value: "   " },
    });
    expect(
      screen.getByRole("button", { name: "Submit response" }),
    ).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText("Add another response…"), {
      target: { value: "Staging" },
    });
    expect(
      screen.getByRole("radio", { name: "Test environment" }),
    ).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Submit response" }));
    expect(submit).toHaveBeenCalledWith({
      destination: { selected: [], custom: "Staging" },
    });
    expect(changed).toHaveBeenLastCalledWith({
      destination: { selected: [], custom: "Staging" },
    });
  });

  it("requests controlled answer and step updates without modifying owner-provided values", () => {
    const changed = vi.fn(),
      stepChanged = vi.fn();
    render(
      <ApprovalCard
        questions={questions}
        step={0}
        answers={{ destination: { selected: ["test"] } }}
        onAnswersChange={changed}
        onStepChange={stepChanged}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText("Add another response…"), {
      target: { value: "Custom" },
    });
    expect(changed).toHaveBeenCalledWith({
      destination: { selected: [], custom: "Custom" },
    });
    expect(
      screen.getByRole("radio", { name: "Test environment" }),
    ).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Next question" }));
    expect(stepChanged).toHaveBeenCalledWith(1);
    expect(
      screen.getByRole("radio", { name: "Test environment" }),
    ).toBeInTheDocument();
  });

  it("queues a single-choice auto-advance after feedback and clears it on unmount", () => {
    vi.useFakeTimers();
    const stepChanged = vi.fn();
    const { unmount } = render(
      <ApprovalCard
        questions={[{ ...questions[0], autoAdvance: true }, questions[1]]}
        step={0}
        onStepChange={stepChanged}
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: "Test environment" }));
    act(() => vi.advanceTimersByTime(239));
    expect(stepChanged).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(stepChanged).toHaveBeenCalledWith(1);
    fireEvent.click(screen.getByRole("radio", { name: "Test environment" }));
    unmount();
    act(() => vi.advanceTimersByTime(500));
    expect(stepChanged).toHaveBeenCalledOnce();
  });

  it("disables question controls while submitting and clamps out-of-range steps", () => {
    render(
      <ApprovalCard
        questions={questions}
        step={999}
        status="submitting"
        defaultAnswers={{ features: { selected: ["logs"] } }}
      />,
    );
    expect(screen.getByRole("checkbox", { name: "Logging" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Submit response" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Previous question" }),
    ).toBeDisabled();
    expect(screen.getByPlaceholderText("Add another response…")).toBeDisabled();
  });
});

describe("agent progress elapsed time", () => {
  it("advances the internal timer, formats minutes and pauses when requested", () => {
    vi.useFakeTimers();
    const { rerender } = render(
      <AgentProgress initialSeconds={59.5} label="Searching" />,
    );
    expect(screen.getByText("59.5s")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByText("1m 0.5s")).toBeInTheDocument();
    rerender(
      <AgentProgress initialSeconds={59.5} label="Searching" running={false} />,
    );
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByText("1m 0.5s")).toBeInTheDocument();
  });

  it("uses controlled elapsed time rather than advancing and clamps negative values", () => {
    vi.useFakeTimers();
    const { rerender } = render(<AgentProgress elapsedSeconds={-10} />);
    expect(screen.getByText("0.0s")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(5000));
    expect(screen.getByText("0.0s")).toBeInTheDocument();
    rerender(<AgentProgress elapsedSeconds={125.2} />);
    expect(screen.getByText("2m 5.2s")).toBeInTheDocument();
  });
});
