// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { createApiToken } from "@/lib/auth/tokens";
import { PUT as saveInstructionsApi } from "@/app/api/v1/agents/[agentId]/instructions/route";
import {
  readOmpInstructions,
  saveOmpInstructionsDraft,
} from "@/lib/agents/omp-config-server";
import {
  cloneAgent,
  createAgent,
  createConversation,
} from "@/lib/agents/mutations";
import {
  publishAgentRevision,
  rollbackAgentRevision,
  requireAgentRevision,
} from "@/lib/agents/revisions";
import { emptyOmpConfig } from "@/lib/agents/omp-config";
import { marketReleaseChecksum } from "@/lib/pi-packages/artifact";
import { AgentRevisionConfigSchema } from "@/lib/agents/revision-types";
import {
  createPrivatePlugin,
  appendPrivatePluginVersion,
} from "@/lib/plugins/local";
import { getPlugin } from "@/lib/plugins/catalog";

const stamp = randomUUID();
const users: string[] = [],
  workspaces: string[] = [];
let userId = "",
  workspaceId = "",
  agentId = "",
  ownerToken = "",
  foreignToken = "",
  slug = "";
beforeAll(async () => {
  for (const name of ["owner", "foreign"]) {
    const user = await db.user.create({
      data: {
        email: `native-capability-${stamp}-${name}@example.invalid`,
        passwordHash: "fixture",
      },
    });
    users.push(user.id);
    const workspace = await db.workspace.create({
      data: {
        slug: `native-capability-${stamp}-${name}`,
        name,
        ownerId: user.id,
      },
    });
    workspaces.push(workspace.id);
    const token = await createApiToken(user.id, "capability integration");
    const agent = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        name,
        slug: name,
        runtimeKind: "omp",
        ompConfig: emptyOmpConfig(),
      },
    });
    if (name === "owner") {
      userId = user.id;
      workspaceId = workspace.id;
      agentId = agent.id;
      ownerToken = token.token;
      slug = workspace.slug;
    } else {
      foreignToken = token.token;
    }
  }
});
afterAll(async () => {
  await db.agent.deleteMany({ where: { workspaceId: { in: workspaces } } });
  await db.workspaceSubagent.deleteMany({
    where: { workspaceId: { in: workspaces } },
  });
  await db.marketInstall.deleteMany({
    where: { targetWorkspaceId: { in: workspaces } },
  });
  await db.marketListing.deleteMany({
    where: { publisherWorkspaceId: { in: workspaces } },
  });
  await db.workspace.deleteMany({ where: { id: { in: workspaces } } });
  await db.user.deleteMany({ where: { id: { in: users } } });
});

it("retains OMP history but refuses creation, publication, rollback and execution admission", async () => {
  const ompConfig = {
    ...emptyOmpConfig(),
    files: [{ path: "AGENTS.md", content: "Retained append instructions" }],
  };
  const config = AgentRevisionConfigSchema.parse({
    schemaVersion: 1,
    runtimeKind: "omp",
    systemPrompt: "Historical primary",
    providerId: null,
    model: null,
    modelProviderIds: [],
    maxSteps: 10,
    disabledBuiltinTools: ["bash"],
    sandboxTemplateId: null,
    environment: {
      kind: "docker",
      image: `fixture@sha256:${"a".repeat(64)}`,
      network: "isolated",
      ompVersion: "18.14.0",
      initialSnapshot: null,
      resourceLimits: { memoryBytes: 536870912, cpus: 1, pidsLimit: 128 },
      credentialReferences: [],
    },
    skills: [],
    knowledgeBaseIds: [],
    packages: [],
    mcpGrants: [],
    a2a: {
      inboundEnabled: false,
      outboundEnabled: false,
      policy: { schemaVersion: 1, targets: [] },
    },
    ompConfig,
    ompConfigChecksum: marketReleaseChecksum(ompConfig),
  });
  const revision = await db.agentRevision.create({
    data: {
      agentId,
      version: 1,
      config: config as Prisma.InputJsonValue,
    },
  });
  await db.agent.update({
    where: { id: agentId },
    data: {
      currentRevisionVersion: 1,
      systemPrompt: config.systemPrompt,
      ompConfig,
    },
  });
  const conversation = await db.conversation.create({
    data: {
      agentId,
      agentRevisionId: revision.id,
      legacyRevisionUnresolved: false,
      messages: {
        create: {
          role: "user",
          parts: [{ type: "text", text: "Historical message" }],
        },
      },
    },
  });
  await expect(
    createAgent(workspaceId, "Forbidden OMP", { runtime: "omp" }),
  ).rejects.toThrow();
  await expect(
    publishAgentRevision(workspaceId, agentId, {
      expectedRevisionId: revision.id,
      config,
    }),
  ).rejects.toMatchObject({ code: "AGENT_EXECUTION_RETIRED" });
  await expect(
    rollbackAgentRevision(workspaceId, agentId, revision.id, revision.id),
  ).rejects.toMatchObject({ code: "AGENT_EXECUTION_RETIRED" });
  await expect(
    requireAgentRevision(db, agentId, revision.id),
  ).rejects.toMatchObject({ code: "AGENT_EXECUTION_RETIRED" });
  await expect(createConversation(workspaceId, agentId)).rejects.toThrow();
  expect(await readOmpInstructions(workspaceId, userId, agentId)).toMatchObject(
    {
      systemPrompt: "Historical primary",
      files: [
        {
          path: "AGENTS.md",
          content: "Retained append instructions",
          mode: "append",
        },
      ],
    },
  );
  await expect(
    saveOmpInstructionsDraft({ workspaceId, userId, agentId, files: [] }),
  ).rejects.toMatchObject({ code: "AGENT_EXECUTION_RETIRED", status: 410 });
  for (const [token, status] of [
    [ownerToken, 410],
    [foreignToken, 404],
  ] as const) {
    const response = await saveInstructionsApi(
      new Request("http://localhost/api/v1/agents/x/instructions", {
        method: "PUT",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ workspace: slug, files: [] }),
      }),
      { params: Promise.resolve({ agentId }) },
    );
    expect(response.status).toBe(status);
  }
  const cloned = await cloneAgent(
    workspaceId,
    agentId,
    "Explicit Pi conversion",
    { copyConversations: true },
  );
  if (!cloned) throw new Error("Pi conversion did not create a draft");
  const draft = await db.agent.findUniqueOrThrow({
    where: { id: cloned.id },
    include: {
      servers: true,
      skills: true,
      piPackages: true,
      conversations: { include: { messages: true } },
    },
  });
  expect(draft).toMatchObject({
    runtimeKind: "pi-sdk",
    providerId: null,
    model: null,
    currentRevisionVersion: 0,
    systemPrompt: "Historical primary\n\nRetained append instructions",
    servers: [],
    skills: [],
    piPackages: [],
  });
  expect(draft.conversations[0]).toMatchObject({
    agentRevisionId: null,
    legacyRevisionUnresolved: true,
  });
  expect(draft.conversations[0].messages[0].parts).toEqual([
    { type: "text", text: "Historical message" },
  ]);
  expect(
    await db.agentRevision.findUniqueOrThrow({ where: { id: revision.id } }),
  ).toEqual(revision);
  expect(
    (
      await db.conversation.findUniqueOrThrow({
        where: { id: conversation.id },
      })
    ).agentRevisionId,
  ).toBe(revision.id);
});

it("persists only version-specific local notes and serves unmatched files as immutable full changelogs", async () => {
  const input = (version: string, text: string) => ({
    name: "@fixture/changelog",
    version,
    runtimeKind: "pi-sdk",
    extensions: ["index.ts"],
    files: [
      { path: "index.ts", content: "export default function () {}" },
      { path: "CHANGELOG.md", content: text },
    ],
  });
  const first = await createPrivatePlugin(
    workspaceId,
    userId,
    input("1.0.0", "## 1.0.0\nFirst notes"),
  );
  const original = await db.marketRelease.findUniqueOrThrow({
    where: { id: first.releaseId },
  });
  expect(original.releaseNotes).toBe("First notes");
  const unmatchedText = "## Unreleased\nFuture plans\n\n## 1.0.0\nFirst notes";
  const unmatched = await appendPrivatePluginVersion(
    workspaceId,
    userId,
    first.installId,
    input("1.0.1", unmatchedText),
  );
  expect(
    (
      await db.marketRelease.findUniqueOrThrow({
        where: { id: unmatched.releaseId },
      })
    ).releaseNotes,
  ).toBeNull();
  const latest = await appendPrivatePluginVersion(
    workspaceId,
    userId,
    first.installId,
    input("1.0.2", "## 1.0.2\nLatest notes\n\n## 1.0.0\nRewritten history"),
  );
  expect(
    (
      await db.marketRelease.findUniqueOrThrow({
        where: { id: latest.releaseId },
      })
    ).releaseNotes,
  ).toBe("Latest notes");
  const plugin = await getPlugin(workspaceId, userId, original.listingId);
  expect(plugin.latestRelease?.changelog).toEqual({
    text: "Latest notes",
    sourceUrl: null,
    kind: "release-notes",
  });
  expect(
    plugin.releases.find((item) => item.id === unmatched.releaseId)?.changelog,
  ).toEqual({ text: unmatchedText, sourceUrl: null, kind: "changelog" });
  expect(
    plugin.releases.find((item) => item.id === first.releaseId)?.changelog
      ?.text,
  ).toBe("First notes");
  expect(
    await db.marketRelease.findUniqueOrThrow({
      where: { id: first.releaseId },
    }),
  ).toEqual(original);
  await expect(
    createPrivatePlugin(
      workspaceId,
      userId,
      input("2.0.0", `## Unreleased\nsk-${"x".repeat(40)}`),
    ),
  ).rejects.toMatchObject({ code: "PLUGIN_CONTAINS_SECRET" });
});
