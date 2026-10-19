import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import messages from "../../messages/en.json";
import { LocaleSwitcher } from "@/components/layout/LocaleSwitcher";

const preferences = vi.hoisted(() => ({ locale: "en", setLocale: vi.fn() }));
vi.mock("next-intl", () => ({
  useLocale: () => preferences.locale,
  useTranslations: () => (key: keyof typeof messages.common) =>
    messages.common[key],
}));
vi.mock("@/lib/i18n/actions", () => ({ setLocale: preferences.setLocale }));

afterEach(() => {
  preferences.locale = "en";
  preferences.setLocale.mockClear();
});

describe("locale preferences", () => {
  it.each(["en", "zh"])(
    "announces the %s selection and changes only when a different language is chosen",
    async (locale) => {
      preferences.locale = locale;
      render(<LocaleSwitcher />);
      const current = screen.getByRole("button", {
        name: locale === "en" ? messages.common.en : messages.common.zh,
      });
      const other = screen.getByRole("button", {
        name: locale === "en" ? messages.common.zh : messages.common.en,
      });
      expect(current).toHaveAttribute("aria-pressed", "true");
      expect(other).toHaveAttribute("aria-pressed", "false");
      await userEvent.click(current);
      expect(preferences.setLocale).not.toHaveBeenCalled();
      await userEvent.click(other);
      expect(preferences.setLocale).toHaveBeenCalledExactlyOnceWith(
        locale === "en" ? "zh" : "en",
      );
    },
  );
});
