import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AuthForm } from "@/components/auth/AuthForm";
import {
  ForgotPasswordForm,
  ResetPasswordForm,
} from "@/components/auth/PasswordRecoveryForms";
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from "@/lib/auth/password-policy";
import type { AuthState } from "@/lib/auth/actions";

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

async function submitForm() {
  const form = document.querySelector("form");
  if (!form) throw new Error("Expected an authentication form");
  await act(async () => {
    fireEvent.submit(form);
  });
}

afterEach(() => {
  vi.clearAllMocks();
  window.history.replaceState(null, "", "/");
});

describe("authentication forms", () => {
  it("submits sign-in credentials and next destination, then presents a server rejection", async () => {
    const action = vi.fn().mockResolvedValue({ error: "Invalid credentials" });
    render(
      <AuthForm mode="login" action={action} next="/app/acme/work?q=a&b=c" />,
    );
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toHaveAttribute(
      "autocomplete",
      "current-password",
    );
    expect(screen.getByLabelText("Password")).not.toHaveAttribute("minlength");
    expect(screen.getByRole("link", { name: "Sign up" })).toHaveAttribute(
      "href",
      "/app/signup?next=%2Fapp%2Facme%2Fwork%3Fq%3Da%26b%3Dc",
    );
    expect(
      screen.getByRole("link", { name: "Forgot password?" }),
    ).toHaveAttribute("href", "/app/forgot-password");
    await userEvent.type(screen.getByLabelText("Email"), "member@example.com");
    await userEvent.type(screen.getByLabelText("Password"), "old-password");
    await submitForm();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Invalid credentials",
    );
    const data = action.mock.calls[0][1] as FormData;
    expect(data.get("email")).toBe("member@example.com");
    expect(data.get("password")).toBe("old-password");
    expect(data.get("next")).toBe("/app/acme/work?q=a&b=c");
    expect(data.has("detectedTimeZone")).toBe(true);
  });

  it("uses signup password constraints and includes optional profile and agreement links", async () => {
    const action = vi.fn().mockResolvedValue({});
    render(<AuthForm mode="signup" action={action} />);
    expect(screen.getByLabelText("Password")).toHaveAttribute(
      "minlength",
      String(PASSWORD_MIN_LENGTH),
    );
    expect(screen.getByLabelText("Password")).toHaveAttribute(
      "maxlength",
      String(PASSWORD_MAX_LENGTH),
    );
    expect(screen.getByLabelText("Password")).toHaveAttribute(
      "autocomplete",
      "new-password",
    );
    expect(
      screen.queryByRole("link", { name: "Forgot password?" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute(
      "href",
      "/app/login",
    );
    expect(document.querySelector('a[href="/terms"]')).toBeInTheDocument();
    expect(document.querySelector('a[href="/privacy"]')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Name"), "New Member");
    await userEvent.type(screen.getByLabelText("Email"), "new@example.com");
    await userEvent.type(
      screen.getByLabelText("Password"),
      "long-password-123",
    );
    await submitForm();
    const data = action.mock.calls[0][1] as FormData;
    expect(data.get("name")).toBe("New Member");
    expect(data.has("next")).toBe(false);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("disables sign-in during a pending action and restores it when the action resolves", async () => {
    let finish!: (state: AuthState) => void;
    const action = vi.fn(
      () =>
        new Promise<AuthState>((resolve) => {
          finish = resolve;
        }),
    );
    render(<AuthForm mode="login" action={action} />);
    await submitForm();
    expect(screen.getByRole("button", { name: "Please wait…" })).toBeDisabled();
    await act(async () => {
      finish({});
    });
    expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
  });
});

describe("password recovery", () => {
  it("replaces an email delivery error with a successful recovery confirmation", async () => {
    actions.forgotPassword
      .mockResolvedValueOnce({ error: "Delivery unavailable" })
      .mockResolvedValueOnce({ success: "Check your inbox" });
    render(<ForgotPasswordForm />);
    await userEvent.type(screen.getByLabelText("Email"), "member@example.com");
    await submitForm();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Delivery unavailable",
    );
    await submitForm();
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Check your inbox",
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Back to sign in" }),
    ).toHaveAttribute("href", "/app/login");
  });

  it("scrubs the reset token from the URL but keeps it in submission until reset succeeds", async () => {
    window.history.replaceState(
      null,
      "",
      "/app/reset-password?token=secret-token",
    );
    actions.resetPassword
      .mockResolvedValueOnce({ error: "Passwords do not match" })
      .mockResolvedValueOnce({ success: "Password reset complete" });
    render(<ResetPasswordForm token="secret-token" />);
    expect(window.location.pathname).toBe("/app/reset-password");
    expect(window.location.search).toBe("");
    await userEvent.type(
      screen.getByLabelText("New password"),
      "replacement-password",
    );
    await userEvent.type(
      screen.getByLabelText("Confirm new password"),
      "replacement-password",
    );
    await submitForm();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Passwords do not match",
    );
    expect(
      (actions.resetPassword.mock.calls[0][1] as FormData).get("token"),
    ).toBe("secret-token");
    await submitForm();
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Password reset complete",
    );
    expect(screen.queryByLabelText("New password")).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Continue to sign in" }),
    ).toHaveAttribute("href", "/app/login");
  });

  it("shows a missing-token warning until a more specific server error is available", async () => {
    window.history.replaceState(null, "", "/app/reset-password?unrelated=1");
    actions.resetPassword.mockResolvedValue({ error: "Token is required" });
    render(<ResetPasswordForm token="" />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "This reset link is invalid or has expired",
    );
    expect(window.location.search).toBe("?unrelated=1");
    await submitForm();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Token is required",
    );
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });
});
