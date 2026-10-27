import "dotenv/config";
import { db } from "@/lib/db";
import { hashPassword } from "@/lib/auth/password";
import { DEFAULT_SANDBOX_IMAGE } from "@/lib/sandboxes/images";

const drafts = [
  {
    name: "Research Copilot",
    slug: "research-copilot",
    systemPrompt:
      "Research technical questions from primary sources and return concise citations.",
    maxSteps: 10,
  },
  {
    name: "Code Quality Guardian",
    slug: "code-quality-guardian",
    systemPrompt:
      "Review code changes for correctness, security, maintainability, and missing verification.",
    maxSteps: 10,
  },
  {
    name: "Incident Response Lead",
    slug: "incident-response-lead",
    systemPrompt:
      "Coordinate incident triage from evidence, reduce impact safely, and preserve a clear decision log.",
    maxSteps: 12,
  },
];

async function main() {
  const passwordHash = await hashPassword("password123");
  await db.$transaction(async (tx) => {
    const user = await tx.user.upsert({
      where: { email: "smoke@example.com" },
      update: {},
      create: {
        email: "smoke@example.com",
        name: "Smoke Test",
        passwordHash,
        role: "admin",
      },
    });
    const workspace = await tx.workspace.upsert({
      where: { slug: "smoke" },
      update: {},
      create: {
        slug: "smoke",
        name: "Smoke Workspace",
        ownerId: user.id,
        members: { create: { userId: user.id, role: "owner" } },
      },
    });
    if (workspace.ownerId !== user.id) {
      throw new Error("The smoke workspace belongs to another account.");
    }
    for (const draft of drafts) {
      const agent = await tx.agent.upsert({
        where: {
          workspaceId_slug: { workspaceId: workspace.id, slug: draft.slug },
        },
        update: {},
        create: { ...draft, workspaceId: workspace.id, runtimeKind: "pi-sdk" },
      });
      const existing = await tx.sandbox.findFirst({
        where: {
          workspaceId: workspace.id,
          agentLinks: { some: { agentId: agent.id, isDefault: true } },
        },
        select: { id: true },
      });
      if (existing) continue;
      const deployment = await tx.deployment.create({
        data: {
          workspaceId: workspace.id,
          name: `Sandbox: ${agent.name} Workspace`,
          source: "sandbox",
          sourceRef: DEFAULT_SANDBOX_IMAGE,
          status: "stopped",
        },
      });
      const sandbox = await tx.sandbox.create({
        data: {
          workspaceId: workspace.id,
          deploymentId: deployment.id,
          name: `${agent.name} Workspace`,
          slug: `${agent.slug}-workspace`,
          kind: "docker",
          image: DEFAULT_SANDBOX_IMAGE,
          network: "isolated",
          agentLinks: { create: { agentId: agent.id, isDefault: true } },
        },
      });
      await tx.deployment.update({
        where: { id: deployment.id },
        data: {
          installCfg: {
            sandboxId: sandbox.id,
            kind: "docker",
            image: DEFAULT_SANDBOX_IMAGE,
            network: "isolated",
            volumeName: `toolplane_sandbox_${sandbox.id.replace(/[^a-zA-Z0-9_.-]/g, "_")}`,
            env: {},
            allowSudo: false,
          },
        },
      });
    }
  });
  console.log(
    "Seeded the smoke account, workspace and three ungranted Pi drafts with stopped templates. " +
      "No catalog content, immutable release, credential, capability grant or runtime was created; " +
      "sync Resource Center content from a configured GitHub registry.",
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
