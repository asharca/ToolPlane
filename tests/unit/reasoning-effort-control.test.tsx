import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import { ReasoningEffortControl } from "@/components/dashboard/agents/ReasoningEffortControl";
import type { ReasoningEffort } from "@/lib/agents/constants";

it("selects stepped thinking effort by keyboard and restores the default", async () => {
  function Control() {
    const [value, setValue] = useState<ReasoningEffort>("default");
    return <ReasoningEffortControl value={value} onChange={setValue} />;
  }

  render(<Control />);
  await userEvent.click(
    screen.getByRole("button", { name: "Thinking effort: Default" }),
  );
  const slider = screen.getByRole("slider", { name: "Thinking effort" });
  slider.focus();
  await userEvent.keyboard("{End}");
  expect(slider).toHaveAttribute("aria-valuetext", "Maximum");
  expect(
    screen.getByRole("button", { name: "Thinking effort: Maximum" }),
  ).toBeInTheDocument();
  await userEvent.keyboard("{ArrowLeft}");
  expect(slider).toHaveAttribute("aria-valuetext", "Extra high");
  await userEvent.click(screen.getByRole("button", { name: /^Default$/ }));
  expect(slider).toHaveAttribute("aria-valuetext", "Default");
  expect(
    screen.getByRole("button", { name: "Thinking effort: Default" }),
  ).toBeInTheDocument();
});
