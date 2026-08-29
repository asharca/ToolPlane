// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createChatAssistant,
  deleteChatAssistant,
  installAssistantMarketRelease,
} from '@/lib/chat/service';
import { db } from '@/lib/db';
import { getMarketListing } from '@/lib/market/listings';
import {
  approveMarketRelease,
  getAssistantMarketTemplate,
  listAssistantMarketTemplates,
  MarketError,
  publishAssistantRelease,
} from '@/lib/market/skills';

const stamp = `${process.pid}-${Date.now()}`;
const namespace = `assistant-market-source-${stamp}`;
let sourceUserId = '';
let targetUserId = '';
let adminUserId = '';
let sourceWorkspaceId = '';
let targetWorkspaceId = '';
let sourceAssistantId = '';
let serverId = '';
let targetDeploymentId = '';
let categoryId = '';
let listingId = '';
let releaseId = '';

describe.sequential('unified assistant market', () => {
  beforeAll(async () => {
    const [sourceUser, targetUser, admin] = await Promise.all([
      db.user.create({ data: { email: `assistant-market-source-${stamp}@test.dev`, passwordHash: 'x' } }),
      db.user.create({ data: { email: `assistant-market-target-${stamp}@test.dev`, passwordHash: 'x' } }),
      db.user.create({ data: { email: `assistant-market-admin-${stamp}@test.dev`, passwordHash: 'x', role: 'admin' } }),
    ]);
    sourceUserId = sourceUser.id;
    targetUserId = targetUser.id;
    adminUserId = admin.id;
    const [sourceWorkspace, targetWorkspace] = await Promise.all([
      db.workspace.create({
        data: {
          slug: namespace,
          name: 'Assistant publisher',
          ownerId: sourceUser.id,
          members: { create: { userId: sourceUser.id, role: 'owner' } },
        },
      }),
      db.workspace.create({
        data: {
          slug: `assistant-market-target-${stamp}`,
          name: 'Assistant user',
          ownerId: targetUser.id,
          members: { create: { userId: targetUser.id, role: 'owner' } },
        },
      }),
    ]);
    sourceWorkspaceId = sourceWorkspace.id;
    targetWorkspaceId = targetWorkspace.id;
    const [provider, server, category] = await Promise.all([
      db.modelProvider.create({
        data: {
          workspaceId: sourceWorkspace.id,
          name: 'Private provider',
          format: 'openai-compatible',
          baseUrl: 'https://example.invalid/v1',
          apiKey: `sk-proj-${'z'.repeat(24)}`,
          models: ['gpt-test'],
        },
      }),
      db.server.create({
        data: {
          slug: `assistant-search-${stamp}`,
          name: 'Assistant search',
          verifiedAt: new Date(),
          installCfg: { source: 'npm', ref: '@modelcontextprotocol/server-memory', env: [] },
        },
      }),
      db.category.create({
        data: { slug: `assistant-market-${stamp}`, name: 'Assistant market' },
      }),
    ]);
    await db.modelProvider.create({
      data: {
        workspaceId: targetWorkspace.id,
        name: 'Target provider',
        format: 'openai-compatible',
        baseUrl: 'https://example.invalid/v1',
        apiKey: 'target-key',
        models: ['gpt-test'],
      },
    });
    serverId = server.id;
    categoryId = category.id;
    const [deployment, targetDeployment] = await Promise.all([
      db.deployment.create({
        data: {
          workspaceId: sourceWorkspace.id,
          serverId: server.id,
          name: 'Search',
          status: 'stopped',
        },
      }),
      db.deployment.create({
        data: {
          workspaceId: targetWorkspace.id,
          serverId: server.id,
          name: 'Search',
          status: 'stopped',
        },
      }),
    ]);
    targetDeploymentId = targetDeployment.id;
    const assistant = await db.chatAssistant.create({
      data: {
        workspaceId: sourceWorkspace.id,
        name: 'Research helper',
        systemPrompt: 'Research and cite the result.',
        modelProviderId: provider.id,
        model: 'gpt-test',
        maxSteps: 6,
        mcpGrants: { create: { deploymentId: deployment.id } },
      },
    });
    sourceAssistantId = assistant.id;
  });

  afterAll(async () => {
    await db.workspace.deleteMany({ where: { id: { in: [sourceWorkspaceId, targetWorkspaceId] } } });
    await db.marketListing.deleteMany({ where: { namespace } });
    await db.server.deleteMany({ where: { id: serverId } });
    await db.category.deleteMany({ where: { id: categoryId } });
    await db.user.deleteMany({ where: { id: { in: [sourceUserId, targetUserId, adminUserId] } } });
    await db.$disconnect();
  });

  it('publishes, reviews, and exposes a secret-free template', async () => {
    await expect(publishAssistantRelease({
      workspaceId: sourceWorkspaceId,
      assistantId: sourceAssistantId,
      publishedById: targetUserId,
      categoryIds: [categoryId],
    })).rejects.toMatchObject({ code: 'not_authorized' } satisfies Partial<MarketError>);

    const published = await publishAssistantRelease({
      workspaceId: sourceWorkspaceId,
      assistantId: sourceAssistantId,
      publishedById: sourceUserId,
      categoryIds: [categoryId],
      listing: { summary: 'A portable research assistant.', tags: ['research'] },
      releaseNotes: 'Initial release.',
    });
    listingId = published.listing.id;
    releaseId = published.release.id;
    expect(published.release.reviewStatus).toBe('pending');
    expect(published.manifest.assistant).toMatchObject({
      modelRequirement: { providerFormat: 'openai-compatible', model: 'gpt-test' },
      mcpRequirements: [{ name: 'Search' }],
    });
    const serialized = JSON.stringify(published.manifest);
    expect(serialized).not.toContain('apiKey');
    expect(serialized).not.toContain(sourceWorkspaceId);

    await approveMarketRelease({ listingId, releaseId, reviewedById: adminUserId });
    const [template, templates, listing] = await Promise.all([
      getAssistantMarketTemplate(releaseId),
      listAssistantMarketTemplates({ q: 'Research helper' }),
      getMarketListing(namespace, published.listing.slug),
    ]);
    expect(template).toMatchObject({
      releaseId,
      listing: { namespace, name: 'Research helper' },
      manifest: { kind: 'assistant' },
    });
    expect(templates).toContainEqual(template);
    expect(listing?.kind).toBe('assistant');
  });

  it('attributes a created assistant to the approved current template', async () => {
    await expect(createChatAssistant(targetUserId, {
      workspaceId: targetWorkspaceId,
      name: 'Invalid template',
      marketTemplateReleaseId: 'missing-release',
    })).rejects.toMatchObject({ status: 400 });
    await expect(createChatAssistant(targetUserId, {
      workspaceId: targetWorkspaceId,
      name: 'Missing requirement',
      marketTemplateReleaseId: releaseId,
    })).rejects.toMatchObject({ status: 400 });

    const assistant = await installAssistantMarketRelease(targetUserId, {
      workspaceId: targetWorkspaceId,
      releaseId,
      name: 'My research helper',
      systemPrompt: 'Customized instructions.',
    });
    expect(assistant.marketTemplateReleaseId).toBe(releaseId);
    expect(assistant.modelProvider?.name).toBe('Target provider');
    expect(assistant.model).toBe('gpt-test');
    expect(assistant.mcpGrants.map(({ deploymentId }) => deploymentId)).toEqual([targetDeploymentId]);
    expect((await db.marketListing.findUnique({ where: { id: listingId } }))?.installCount).toBe(1);
    await deleteChatAssistant(targetUserId, assistant.id);
    expect((await db.marketListing.findUnique({ where: { id: listingId } }))?.installCount).toBe(0);
  });

  it('blocks assistant releases that contain credentials', async () => {
    const unsafe = await db.chatAssistant.create({
      data: {
        workspaceId: sourceWorkspaceId,
        name: 'Unsafe helper',
        systemPrompt: `Use sk-proj-${'a'.repeat(24)}`,
      },
    });
    await expect(publishAssistantRelease({
      workspaceId: sourceWorkspaceId,
      assistantId: unsafe.id,
      publishedById: sourceUserId,
      categoryIds: [categoryId],
    })).rejects.toMatchObject({ code: 'invalid_manifest' } satisfies Partial<MarketError>);
    expect(await db.marketListing.findUnique({ where: { sourceChatAssistantId: unsafe.id } })).toBeNull();
  });

  it('blocks assistants that depend on custom or unverified MCPs', async () => {
    const customDeployment = await db.deployment.create({
      data: {
        workspaceId: sourceWorkspaceId,
        name: 'Private custom MCP',
        source: 'npm',
        sourceRef: '@example/private-mcp',
        status: 'stopped',
      },
    });
    const assistant = await db.chatAssistant.create({
      data: {
        workspaceId: sourceWorkspaceId,
        name: 'Nonportable helper',
        mcpGrants: { create: { deploymentId: customDeployment.id } },
      },
    });
    await expect(publishAssistantRelease({
      workspaceId: sourceWorkspaceId,
      assistantId: assistant.id,
      publishedById: sourceUserId,
      categoryIds: [categoryId],
    })).rejects.toMatchObject({ code: 'invalid_manifest' } satisfies Partial<MarketError>);
    expect(await db.marketListing.findUnique({ where: { sourceChatAssistantId: assistant.id } })).toBeNull();
  });
});
