import { describe, expect, it } from "vitest";
import { conversationTitleFromParts } from "@/lib/agents/conversation-title";
import { normalizeGeneratedConversationTitle } from "@/lib/agents/conversation-naming";

describe("automatic conversation title boundaries", () => {
  it.each([
    "请帮我分析这份报告并整理所有关键数据和风险以及后续改进建议",
    "Investigate intermittent conversation ordering changes after background updates",
    "😀".repeat(24),
  ])("caps automatic titles without splitting Unicode characters", (text) => {
    const titles = [
      conversationTitleFromParts([{ type: "text", text }]),
      normalizeGeneratedConversationTitle(`标题：${text}。\nExtra explanation`),
    ];
    for (const title of titles) {
      expect(title).toBe(`${Array.from(text).slice(0, 19).join("")}…`);
      expect(Array.from(title ?? "")).toHaveLength(20);
      expect(title?.isWellFormed()).toBe(true);
    }
  });

  it("preserves short topics and ignores empty or non-text content", () => {
    expect(normalizeGeneratedConversationTitle('"排查会话排序。"')).toBe(
      "排查会话排序",
    );
    expect(
      conversationTitleFromParts([
        { type: "file", filename: "private-report.pdf" },
        { type: "text", text: "  " },
        { type: "text", text: "修复\n  排序" },
      ]),
    ).toBe("修复 排序");
    expect(
      conversationTitleFromParts([{ type: "text", text: "  " }]),
    ).toBeNull();
    expect(normalizeGeneratedConversationTitle("标题：")).toBeNull();
  });
});
