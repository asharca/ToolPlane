import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChangePasswordForm } from "@/components/auth/PasswordRecoveryForms";

const actions = vi.hoisted(() => ({
  changePassword: vi.fn(),
  forgotPassword: vi.fn(),
  resetPassword: vi.fn(),
}));
vi.mock("@/lib/auth/actions", () => ({
  changePasswordAction: actions.changePassword,
  forgotPasswordAction: actions.forgotPassword,
  resetPasswordAction: actions.resetPassword,
}));

async function fillPasswords() {
  await userEvent.type(
    screen.getByLabelText("Current password"),
    "current-pass-123",
  );
  await userEvent.type(
    screen.getByLabelText("New password"),
    "replacement-pass-456",
  );
  await userEvent.type(
    screen.getByLabelText("Confirm new password"),
    "replacement-pass-456",
  );
}

describe("password settings secret lifecycle", () => {
  beforeEach(() => {
    actions.changePassword.mockReset();
  });

  it("clears all password fields after each successful change, even when the success message is unchanged", async () => {
    actions.changePassword.mockImplementation(async () => ({
      success: "Changed",
    }));
    render(<ChangePasswordForm />);
    for (let save = 0; save < 2; save++) {
      await fillPasswords();
      await userEvent.click(
        screen.getByRole("button", { name: "Change password" }),
      );
      await waitFor(() => {
        expect(screen.getByLabelText("Current password")).toHaveValue("");
        expect(screen.getByLabelText("New password")).toHaveValue("");
        expect(screen.getByLabelText("Confirm new password")).toHaveValue("");
      });
    }
  });

  it("preserves entered values after a rejected change so the user can correct it", async () => {
    actions.changePassword.mockResolvedValue({ error: "Rejected" });
    render(<ChangePasswordForm />);
    await fillPasswords();
    await userEvent.click(
      screen.getByRole("button", { name: "Change password" }),
    );
    await screen.findByRole("alert");
    expect(screen.getByLabelText("Current password")).toHaveValue(
      "current-pass-123",
    );
    expect(screen.getByLabelText("New password")).toHaveValue(
      "replacement-pass-456",
    );
    expect(screen.getByLabelText("Confirm new password")).toHaveValue(
      "replacement-pass-456",
    );
  });
});
