// @vitest-environment node
import { randomUUID } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import {
  applyAgentResourceReview,
  prepareAgentResourceReview,
  type AgentResourceReviewScope,
} from "@/lib/agents/resource-apply";
import {
  publishAgentRevision,
  resolvePinnedAgent,
} from "@/lib/agents/revisions";
import { marketReleaseChecksum } from "@/lib/market/artifact";
import { publishFixtureAgentRevision } from "./agent-revision-fixture";

// These tests intentionally run the real publisher and Docker native preflight.
// Requires the integration database and toolplane-pi-package-capture:0.87.1;
// the fake environment digest from the shared fixture is never executed.
const stamp = randomUUID();
let workspaceId = "";
let userId = "";
let secondOwnerId = "";
let providerId = "";
let sequence = 0;
let stubbedSecret = false;

beforeAll(async () => {
  if (!process.env.AUTH_SECRET) {
    vi.stubEnv("AUTH_SECRET", `resource-apply-fixture-${stamp}`);
    stubbedSecret = true;
  }
  const user = await db.user.create({
    data: {
      email: `resource-apply-${stamp}@test.invalid`,
      passwordHash: "fixture",
    },
  });
  userId = user.id;
  const secondOwner = await db.user.create({
    data: {
      email: `resource-apply-second-${stamp}@test.invalid`,
      passwordHash: "fixture",
    },
  });
  secondOwnerId = secondOwner.id;
  const workspace = await db.workspace.create({
    data: {
      ownerId: userId,
      slug: `resource-apply-${stamp}`,
      name: "Single resource publication regression",
      members: {
        create: [
          { userId, role: "owner" },
          { userId: secondOwnerId, role: "owner" },
        ],
      },
    },
  });
  workspaceId = workspace.id;
  const provider = await db.modelProvider.create({
    data: {
      workspaceId,
      name: "Resource apply fixture",
      format: "openai",
      baseUrl: "https://resource-apply.test.invalid",
      apiKey: "fixture",
      models: ["published-model", "draft-model"],
    },
  });
  providerId = provider.id;
});

afterAll(async () => {
  try {
    if (workspaceId) {
      await db.conversation.deleteMany({ where: { agent: { workspaceId } } });
      await db.workspace.delete({ where: { id: workspaceId } });
    }
    const ids = [userId, secondOwnerId].filter(Boolean);
    if (ids.length) await db.user.deleteMany({ where: { id: { in: ids } } });
  } finally {
    if (stubbedSecret) vi.unstubAllEnvs();
  }
});

async function installedSkill(slug: string, nativeName = slug) {
  const markdown = `---\nname: ${nativeName}\ndescription: Full custom Skill regression artifact\n---\n\n# Reviewed procedure\n\nRead references/procedure.md and assets/dependency.bin before answering.\n\nDo not omit these instructions.\n`;
  const files = [
    {
      path: "references/procedure.md",
      content: "# Dependency\n\nKeep the full text.\n",
    },
    {
      path: "assets/dependency.bin",
      content: Buffer.from([0, 1, 127, 128, 255]).toString("base64"),
      encoding: "base64" as const,
    },
  ];
  const skill = await db.installedSkill.create({
    data: {
      workspaceId,
      source: "custom",
      status: "published",
      name: nativeName,
      slug,
      description: "Full custom Skill regression artifact",
      content: markdown,
      files,
      userInvocable: true,
      agentInvocable: true,
    },
  });
  return { skill, markdown, files };
}

async function fixture(
  options: { unpublished?: boolean; collision?: boolean } = {},
) {
  const slug = `resource-apply-${++sequence}`;
  const frozen = await installedSkill(`${slug}-frozen`);
  const target = await installedSkill(
    `${slug}-target`,
    options.collision ? `${slug}-frozen` : `${slug}-target`,
  );
  const draft = await installedSkill(`${slug}-draft`);
  const agent = await db.agent.create({
    data: {
      workspaceId,
      name: slug,
      slug,
      runtimeKind: "pi-sdk",
      providerId,
      model: "published-model",
      systemPrompt: "Published system prompt",
      maxSteps: 7,
      disabledBuiltinTools: ["bash"],
      skills: { create: { installedSkillId: frozen.skill.id } },
    },
  });
  const revision = options.unpublished
    ? null
    : await publishFixtureAgentRevision(workspaceId, agent.id);
  await db.agent.update({
    where: { id: agent.id },
    data: {
      model: "draft-model",
      systemPrompt: "Unrelated unpublished system prompt",
      skills: { create: { installedSkillId: draft.skill.id } },
    },
  });
  const other = await db.agent.create({
    data: {
      workspaceId,
      name: `${slug}-other`,
      slug: `${slug}-other`,
      runtimeKind: "pi-sdk",
      systemPrompt: "Other Agent draft",
    },
  });
  const scope: AgentResourceReviewScope = {
    workspaceId,
    userId,
    agentId: agent.id,
    resourceKind: "skill",
    resourceId: target.skill.id,
  };
  return { agent, other, frozen, target, draft, revision, scope };
}

// Include all authority-bearing rows, not only the new Skill relation, so a
// failed apply cannot silently leave a grant, revision, or default mutation.
async function authority() {
  return {
    agents: await db.agent.findMany({
      where: { workspaceId },
      orderBy: { id: "asc" },
    }),
    revisions: await db.agentRevision.findMany({
      where: { agent: { workspaceId } },
      orderBy: { id: "asc" },
    }),
    skills: await db.agentSkill.findMany({
      where: { agent: { workspaceId } },
      orderBy: [{ agentId: "asc" }, { installedSkillId: "asc" }],
    }),
    servers: await db.agentServer.findMany({
      where: { agent: { workspaceId } },
      orderBy: [{ agentId: "asc" }, { deploymentId: "asc" }],
    }),
  };
}

describe.sequential("reviewed single-resource Skill publication", () => {
  it("reviews the signed full artifact for 15 minutes and publishes only that Skill over the exact current config, preserving pins and drafts", async () => {
    const { agent, other, target, draft, revision, scope } = await fixture();
    if (!revision) throw new Error("Published fixture required");
    const conversation = await db.conversation.create({
      data: {
        agentId: agent.id,
        agentRevisionId: revision.id,
        legacyRevisionUnresolved: false,
      },
    });
    const before = await authority();
    const review = await prepareAgentResourceReview(scope);
    expect(await authority()).toEqual(before);
    expect(review.expectedRevisionId).toBe(revision.id);
    expect(review.skill).toEqual({
      installedSkillId: target.skill.id,
      name: target.skill.name,
      slug: target.skill.slug,
      description: target.skill.description,
      markdown: target.markdown,
      files: target.files,
      checksum: marketReleaseChecksum({
        name: target.skill.name,
        slug: target.skill.slug,
        description: target.skill.description,
        markdown: target.markdown,
        files: target.files,
      }),
      userInvocable: true,
      agentInvocable: true,
      effort: target.skill.effort,
    });
    expect(review.sourceChecksum).toBe(marketReleaseChecksum(review.skill));
    const verified = await jwtVerify(
      review.reviewReceipt,
      new TextEncoder().encode(process.env.AUTH_SECRET),
      {
        algorithms: ["HS256"],
        audience: "toolplane:agent-resource-review",
        issuer: "toolplane",
      },
    );
    expect(verified.payload).toMatchObject({
      ...scope,
      expectedRevisionId: revision.id,
      sourceChecksum: review.sourceChecksum,
    });
    expect(verified.payload.exp).toBe((verified.payload.iat ?? 0) + 15 * 60);
    expect(review.expiresAt).toBe(
      new Date((verified.payload.exp ?? 0) * 1_000).toISOString(),
    );
    const applied = await applyAgentResourceReview({ ...scope, ...review });
    expect(applied.version).toBe(revision.version + 1);
    expect(applied.config).toEqual({
      ...revision.config,
      skills: [...revision.config.skills, review.skill],
    });
    expect(
      applied.config.skills.some(
        (skill) => skill.installedSkillId === draft.skill.id,
      ),
    ).toBe(false);
    const after = await authority();
    expect(after.agents).toEqual(
      before.agents.map((entry) =>
        entry.id === agent.id
          ? expect.objectContaining({
              ...entry,
              currentRevisionVersion: applied.version,
              updatedAt: expect.any(Date),
            })
          : entry,
      ),
    );
    expect(after.servers).toEqual(before.servers);
    expect(after.skills).toHaveLength(before.skills.length + 1);
    expect(after.skills).toEqual(expect.arrayContaining(before.skills));
    expect(after.skills).toContainEqual(
      expect.objectContaining({
        agentId: agent.id,
        installedSkillId: target.skill.id,
      }),
    );
    expect(after.revisions).toHaveLength(before.revisions.length + 1);
    expect(after.revisions).toEqual(expect.arrayContaining(before.revisions));
    expect(
      await db.agent.findUniqueOrThrow({ where: { id: other.id } }),
    ).toEqual(before.agents.find((entry) => entry.id === other.id));
    expect(
      await db.conversation.findUniqueOrThrow({
        where: { id: conversation.id },
      }),
    ).toEqual(conversation);
    const pinned = await resolvePinnedAgent(
      agent,
      conversation.agentRevisionId,
    );
    expect(pinned.revisionConfig).toEqual(revision.config);
    expect(pinned.skills.map((entry) => entry.installedSkill.id)).toEqual(
      revision.config.skills.map((skill) => skill.installedSkillId),
    );
    expect(pinned.systemPrompt).toBe("Published system prompt");
    expect(pinned.model).toBe("published-model");
  }, 120_000);

  it("requires explicit revision preparation for an unpublished Agent without writing grants or revisions", async () => {
    const { scope } = await fixture({ unpublished: true });
    const before = await authority();
    await expect(prepareAgentResourceReview(scope)).rejects.toMatchObject({
      code: "revisionPreparationRequired",
    });
    expect(await authority()).toEqual(before);
  });

  it("rejects stale publication CAS without adding a grant or advancing the new default", async () => {
    const { scope, revision } = await fixture();
    if (!revision) throw new Error("Published fixture required");
    const review = await prepareAgentResourceReview(scope);
    await publishAgentRevision(workspaceId, scope.agentId, {
      expectedRevisionId: revision.id,
      config: {
        ...revision.config,
        systemPrompt: "Separately published newer default",
      },
    });
    const before = await authority();
    await expect(
      applyAgentResourceReview({ ...scope, ...review }),
    ).rejects.toMatchObject({ code: "AGENT_REVISION_CONFLICT" });
    expect(await authority()).toEqual(before);
  }, 120_000);

  it.each(["markdown", "dependency"] as const)(
    "rejects changed reviewed Skill %s without authority writes",
    async (change) => {
      const { scope, target } = await fixture();
      const review = await prepareAgentResourceReview(scope);
      await db.installedSkill.update({
        where: { id: target.skill.id },
        data:
          change === "markdown"
            ? { content: `${target.markdown}\nChanged after review.\n` }
            : {
                files: [
                  ...target.files,
                  {
                    path: "references/changed.md",
                    content: "Unreviewed dependency",
                  },
                ],
              },
      });
      const before = await authority();
      await expect(
        applyAgentResourceReview({ ...scope, ...review }),
      ).rejects.toMatchObject({ code: "resourceChanged" });
      expect(await authority()).toEqual(before);
    },
    120_000,
  );

  it.each([
    "altered",
    "wrong-agent",
    "wrong-resource",
    "wrong-user",
    "expired",
  ] as const)(
    "rejects a %s receipt without authority writes",
    async (failure) => {
      const { scope, other, draft } = await fixture();
      const review = await prepareAgentResourceReview(scope);
      let reviewReceipt = review.reviewReceipt;
      if (failure === "altered") {
        const parts = reviewReceipt.split(".");
        parts[1] = Buffer.from(
          JSON.stringify({ ...scope, sourceChecksum: "forged" }),
        ).toString("base64url");
        reviewReceipt = parts.join(".");
      }
      if (failure === "expired") {
        const { payload } = await jwtVerify(
          reviewReceipt,
          new TextEncoder().encode(process.env.AUTH_SECRET),
        );
        reviewReceipt = await new SignJWT({
          ...payload,
          exp: Math.floor(Date.now() / 1_000) - 1,
        })
          .setProtectedHeader({ alg: "HS256", typ: "JWT" })
          .sign(new TextEncoder().encode(process.env.AUTH_SECRET));
      }
      const input = {
        ...scope,
        expectedRevisionId: review.expectedRevisionId,
        reviewReceipt,
        ...(failure === "wrong-agent" ? { agentId: other.id } : {}),
        ...(failure === "wrong-resource" ? { resourceId: draft.skill.id } : {}),
        ...(failure === "wrong-user" ? { userId: secondOwnerId } : {}),
      };
      const before = await authority();
      await expect(applyAgentResourceReview(input)).rejects.toMatchObject({
        code: failure === "expired" ? "reviewExpired" : "reviewRequired",
      });
      expect(await authority()).toEqual(before);
    },
    120_000,
  );

  it("rolls back the Skill relation and revision when the real native loader rejects a name already frozen in the current revision", async () => {
    const { scope, frozen, revision } = await fixture({ collision: true });
    if (!revision) throw new Error("Published fixture required");
    const review = await prepareAgentResourceReview(scope);
    expect(review.skill?.name).toBe(revision.config.skills[0].name);
    expect(review.skill?.installedSkillId).not.toBe(frozen.skill.id);
    const before = await authority();
    await expect(
      applyAgentResourceReview({ ...scope, ...review }),
    ).rejects.toThrow("PI_CAPABILITY_CONFLICT");
    expect(await authority()).toEqual(before);
  }, 120_000);
});
