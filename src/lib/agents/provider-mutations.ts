import "server-only";
import {
  type WorkspaceScope,
  workspaceScopeWhere,
} from "@/lib/workspace/scope";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { writeAudit } from "@/lib/observability/audit";
import {
  defaultProviderModel,
  fillProviderModelMetadata,
  type ProviderModelValues,
} from "@/lib/agents/model-catalog";
import { matchingPiModelReferences } from "@/lib/agents/provider-catalog";
import { uniqueIds } from "./agent-mutation-guards";

type LockedModelProvider = {
  id: string;
  name: string;
  format: string;
  baseUrl: string;
  models: string[];
};

export async function lockProvider(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  providerId: string,
): Promise<LockedModelProvider | null> {
  const providers = await tx.$queryRaw<LockedModelProvider[]>`
    SELECT "id", "name", "format", "baseUrl", "models"
    FROM "ModelProvider"
    WHERE "id" = ${providerId} AND "workspaceId" = ${workspaceId}
    FOR UPDATE
  `;
  return providers[0] ?? null;
}

export async function createProvider(
  scope: WorkspaceScope,
  data: { name: string; format: string; baseUrl: string; apiKey: string },
) {
  const { id: workspaceId, actorUserId: actorId } = scope;
  return db.$transaction(async (tx) => {
    if (
      !(await tx.workspace.findFirst({
        where: workspaceScopeWhere(scope),
        select: { id: true },
      }))
    )
      throw new Error("Workspace access denied.");
    const provider = await tx.modelProvider.create({
      data: { workspaceId, ...data },
    });
    await writeAudit(tx, {
      actorId,
      workspaceId,
      action: "provider.created",
      targetType: "modelProvider",
      targetId: provider.id,
      changes: {
        name: data.name,
        format: data.format,
        baseUrl: data.baseUrl,
        credentialChanged: true,
      },
    });
    return provider;
  });
}

export async function updateProvider(
  scope: WorkspaceScope,
  providerId: string,
  data: { name: string; format: string; baseUrl: string; apiKey?: string },
) {
  const { id: workspaceId, actorUserId: actorId } = scope;
  await db.$transaction(async (tx) => {
    if (!(await lockProvider(tx, workspaceId, providerId))) return;
    const before = await tx.modelProvider.findFirst({
      where: { id: providerId, workspace: workspaceScopeWhere(scope) },
      select: { name: true, format: true, baseUrl: true },
    });
    const changed = await tx.modelProvider.updateMany({
      where: { id: providerId, workspaceId },
      data,
    });
    if (!changed.count) return;
    await writeAudit(tx, {
      actorId,
      workspaceId,
      action: "provider.changed",
      targetType: "modelProvider",
      targetId: providerId,
      changes: {
        before,
        after: { name: data.name, format: data.format, baseUrl: data.baseUrl },
        credentialChanged: data.apiKey !== undefined,
      },
    });
  });
}

export async function deleteProvider(
  scope: WorkspaceScope,
  providerId: string,
) {
  const { id: workspaceId, actorUserId: actorId } = scope;
  return db.$transaction(async (tx) => {
    if (!(await lockProvider(tx, workspaceId, providerId))) return;

    if (
      !(await tx.modelProvider.findFirst({
        where: { id: providerId, workspace: workspaceScopeWhere(scope) },
        select: { id: true },
      }))
    )
      return;

    await tx.agent.updateMany({
      where: { workspaceId, providerId },
      data: { providerId: null, model: null },
    });
    await tx.workspace.updateMany({
      where: { id: workspaceId, defaultModelProviderId: providerId },
      data: { defaultModelProviderId: null, defaultModel: null },
    });
    await tx.workspace.updateMany({
      where: { id: workspaceId, titleModelProviderId: providerId },
      data: { titleModelProviderId: null, titleModel: null },
    });
    const changed = await tx.modelProvider.deleteMany({
      where: { id: providerId, workspace: workspaceScopeWhere(scope) },
    });
    if (!changed.count) throw new Error("Model provider not found.");
    await writeAudit(tx, {
      actorId,
      workspaceId,
      action: "provider.deleted",
      targetType: "modelProvider",
      targetId: providerId,
    });
  });
}

function providerModelData(model: ProviderModelValues) {
  return {
    ...model,
    cost: model.cost
      ? (model.cost as unknown as Prisma.InputJsonValue)
      : Prisma.DbNull,
  };
}

async function fillStoredProviderModels(
  tx: Prisma.TransactionClient,
  provider: {
    id: string;
    name: string;
    format: string;
    baseUrl: string;
    models: string[];
  },
) {
  const records = await tx.providerModel.findMany({
    where: { providerId: provider.id },
    select: {
      modelId: true,
      name: true,
      group: true,
      primaryType: true,
      source: true,
      capabilities: true,
      inputModalities: true,
      contextWindow: true,
      maxInputTokens: true,
      maxOutputTokens: true,
      cost: true,
    },
  });
  const storedIds = new Set(records.map(({ modelId }) => modelId));
  const missing = uniqueIds(provider.models).filter(
    (modelId) => !storedIds.has(modelId),
  );
  if (missing.length) {
    await tx.providerModel.createMany({
      data: missing.map((modelId) => ({
        ...providerModelData(
          fillProviderModelMetadata(
            defaultProviderModel(modelId),
            matchingPiModelReferences(
              provider.format,
              [modelId],
              provider.baseUrl,
              provider.name,
            )[0] ?? null,
          ),
        ),
        providerId: provider.id,
        source: "remote",
      })),
    });
  }
  for (const record of records) {
    const { source, ...model } = record as ProviderModelValues & {
      source: string;
    };
    const reference =
      matchingPiModelReferences(
        provider.format,
        [model.modelId, model.name],
        provider.baseUrl,
        provider.name,
      )[0] ?? null;
    const filled = fillProviderModelMetadata(
      source === "remote" && reference
        ? {
            ...model,
            contextWindow: reference.contextWindow,
            maxOutputTokens: reference.maxOutputTokens,
            cost: reference.cost,
          }
        : model,
      reference,
    );
    const data = Object.fromEntries(
      Object.entries(filled).filter(
        ([key, value]) => value !== model[key as keyof ProviderModelValues],
      ),
    ) as Prisma.ProviderModelUpdateInput;
    if (Object.keys(data).length) {
      await tx.providerModel.update({
        where: {
          providerId_modelId: {
            providerId: provider.id,
            modelId: model.modelId,
          },
        },
        data,
      });
    }
  }
}

export async function backfillProviderModels(workspaceId: string) {
  const providers = await db.modelProvider.findMany({
    where: { workspaceId },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  for (const { id } of providers) {
    await db.$transaction(async (tx) => {
      const provider = await lockProvider(tx, workspaceId, id);
      if (provider) await fillStoredProviderModels(tx, provider);
    });
  }
}

export async function setProviderModels(
  workspaceId: string,
  providerId: string,
  models: string[],
) {
  await db.$transaction(async (tx) => {
    const provider = await lockProvider(tx, workspaceId, providerId);
    if (!provider) return;
    const remoteModelIds = uniqueIds(
      models.map((model) => model.trim()).filter(Boolean),
    );
    await tx.providerModel.deleteMany({
      where: {
        providerId,
        source: "remote",
        ...(remoteModelIds.length
          ? { modelId: { notIn: remoteModelIds } }
          : {}),
      },
    });
    const manualModels = await tx.providerModel.findMany({
      where: { providerId, source: "manual" },
      select: { modelId: true },
      orderBy: { createdAt: "asc" },
    });
    const nextModels = uniqueIds([
      ...remoteModelIds,
      ...manualModels.map(({ modelId }) => modelId),
    ]);
    await fillStoredProviderModels(tx, { ...provider, models: nextModels });
    await tx.modelProvider.update({
      where: { id: providerId },
      data: {
        models: nextModels,
        modelsFetchedAt: new Date(),
      },
    });
  });
}

export class ProviderModelError extends Error {}

export async function addProviderModels(
  workspaceId: string,
  providerId: string,
  models: ProviderModelValues[],
) {
  await db.$transaction(async (tx) => {
    const provider = await lockProvider(tx, workspaceId, providerId);
    if (!provider) throw new ProviderModelError("Provider not found.");
    const requestedIds = models.map(({ modelId }) => modelId);
    if (
      new Set(requestedIds).size !== requestedIds.length ||
      requestedIds.some((modelId) => provider.models.includes(modelId))
    ) {
      throw new ProviderModelError("A model with that ID already exists.");
    }
    await tx.providerModel.createMany({
      data: models.map((model) => ({
        ...providerModelData(
          fillProviderModelMetadata(
            model,
            matchingPiModelReferences(
              provider.format,
              [model.modelId, model.name],
              provider.baseUrl,
              provider.name,
            )[0] ?? null,
          ),
        ),
        providerId,
        source: "manual",
      })),
    });
    await tx.modelProvider.update({
      where: { id: providerId },
      data: { models: [...provider.models, ...requestedIds] },
    });
  });
}

export async function updateProviderModel(
  workspaceId: string,
  providerId: string,
  model: ProviderModelValues,
) {
  await db.$transaction(async (tx) => {
    const provider = await lockProvider(tx, workspaceId, providerId);
    if (!provider) throw new ProviderModelError("Provider not found.");
    if (!provider.models.includes(model.modelId)) {
      throw new ProviderModelError("Model not found.");
    }
    const stored = await tx.providerModel.findUnique({
      where: { providerId_modelId: { providerId, modelId: model.modelId } },
      select: { cost: true },
    });
    const metadata = fillProviderModelMetadata(
      {
        ...model,
        cost: model.cost ?? (stored?.cost as ProviderModelValues["cost"]),
      },
      matchingPiModelReferences(
        provider.format,
        [model.modelId, model.name],
        provider.baseUrl,
        provider.name,
      )[0] ?? null,
    );
    const { modelId, ...values } = providerModelData(metadata);
    await tx.providerModel.upsert({
      where: { providerId_modelId: { providerId, modelId } },
      create: { providerId, modelId, ...values, source: "manual" },
      update: { ...values, source: "manual" },
    });
  });
}

export async function deleteProviderModel(
  workspaceId: string,
  providerId: string,
  modelId: string,
) {
  await db.$transaction(async (tx) => {
    if (!(await lockProvider(tx, workspaceId, providerId))) {
      throw new ProviderModelError("Provider not found.");
    }
    const provider = await tx.modelProvider.findUnique({
      where: { id: providerId },
      select: { models: true },
    });
    if (!provider?.models.includes(modelId))
      throw new ProviderModelError("Model not found.");
    const [agent, assistant, knowledgeBase, workspace] = await Promise.all([
      tx.agent.findFirst({
        where: { workspaceId, providerId, model: modelId },
        select: { id: true },
      }),
      tx.chatAssistant.findFirst({
        where: { workspaceId, modelProviderId: providerId, model: modelId },
        select: { id: true },
      }),
      tx.knowledgeBase.findFirst({
        where: { workspaceId, providerId, embeddingModel: modelId },
        select: { id: true },
      }),
      tx.workspace.findFirst({
        where: {
          id: workspaceId,
          OR: [
            { defaultModelProviderId: providerId, defaultModel: modelId },
            { titleModelProviderId: providerId, titleModel: modelId },
          ],
        },
        select: { id: true },
      }),
    ]);
    if (agent || assistant || knowledgeBase || workspace) {
      throw new ProviderModelError(
        "This model is in use and cannot be removed.",
      );
    }
    await tx.providerModel.deleteMany({ where: { providerId, modelId } });
    await tx.modelProvider.update({
      where: { id: providerId },
      data: { models: provider.models.filter((model) => model !== modelId) },
    });
  });
}
