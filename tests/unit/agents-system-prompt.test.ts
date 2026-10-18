import { describe, it, expect } from "vitest";
import { assembleSystemPrompt } from "@/lib/agents/system-prompt";
import type { SkillForPrompt } from "@/lib/agents/resolve";

const catalogSkill = (
  slug: string,
  name: string,
  description: string,
): SkillForPrompt => ({
  skillId: slug,
  skill: { slug, name, description, author: null },
  name: null,
  slug: null,
  description: null,
  content: null,
  userInvocable: true,
  agentInvocable: true,
  effort: null,
});

describe("assembleSystemPrompt", () => {
  it("combines the base prompt with a Pi-style skill catalog", () => {
    const out = assembleSystemPrompt("You are helpful.", [
      catalogSkill("web-scraper", "Web Scraper", "Scrapes pages."),
    ]);
    expect(out).toContain("You are helpful.");
    expect(out).toContain(
      "Use the skill_read_file tool to load a skill's SKILL.md",
    );
    expect(out).toContain("<available_skills>");
    expect(out).toContain("<name>Web Scraper</name>");
    expect(out).toContain("<description>Scrapes pages.</description>");
    expect(out).toContain(
      "<location>toolplane://skills/web-scraper/SKILL.md</location>",
    );
    expect(out).not.toContain("name: web-scraper");
  });

  it("omits the base section when no system prompt is set", () => {
    const out = assembleSystemPrompt(null, [catalogSkill("s", "Thing", "")]);
    expect(out).toContain("<available_skills>");
    expect(out).toContain("<name>Thing</name>");
    expect(out).not.toContain("You are helpful.");
  });

  it("returns an empty string when there is nothing to assemble", () => {
    expect(assembleSystemPrompt("   ", [])).toBe("");
  });

  it("lists custom skill metadata without eagerly including its content", () => {
    const custom: SkillForPrompt = {
      skillId: null,
      skill: null,
      name: "My Custom Skill",
      slug: "my-custom-skill",
      description: "Does something custom.",
      content: "# My Custom Skill\n\nSECRET_NEVER_EAGER",
      userInvocable: true,
      agentInvocable: true,
      effort: "default",
    };
    const out = assembleSystemPrompt(null, [custom]);
    expect(out).toContain("<name>My Custom Skill</name>");
    expect(out).toContain("<description>Does something custom.</description>");
    expect(out).not.toContain("SECRET_NEVER_EAGER");
    expect(out).not.toContain("<skill_markdown>");
  });

  it("escapes skill catalog fields", () => {
    const out = assembleSystemPrompt(null, [
      catalogSkill("quoted", 'Quoted "Skill"', "Escapes </skill> & 'values'."),
    ]);

    expect(out).toContain("<name>Quoted &quot;Skill&quot;</name>");
    expect(out).toContain(
      "<description>Escapes &lt;/skill&gt; &amp; &apos;values&apos;.</description>",
    );
  });

  it("adds authorized knowledge guidance without requiring a base prompt or skill catalog", () => {
    const prompt = assembleSystemPrompt(undefined, [], true);
    expect(prompt).toContain("Use knowledge_search");
    expect(prompt).toContain("Cite the returned filenames and paths");
    expect(prompt).not.toContain("available_skills");
  });

  it("falls back through optional skill metadata and encodes identifier paths", () => {
    const prompt = assembleSystemPrompt(
      " base ",
      [{ skillId: null, skill: null, name: "A", slug: "a/b" }],
      true,
    );
    expect(prompt).toContain("base\n\n---\n\n");
    expect(prompt).toContain("<description></description>");
    expect(prompt).toContain("toolplane://skills/a%2Fb/SKILL.md");
  });
});
