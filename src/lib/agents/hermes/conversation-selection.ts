import 'server-only';

import {
  bindHermesAgentModelProvider,
  type HermesConversationSelection,
} from '@/lib/agents/mutations';
import {
  ensureHermesProfileProjection,
  hasHermesProfileModel,
  HermesProfileError,
  listHermesProfileModels,
  listHermesProfiles,
  normalizeHermesProfile,
  supportsHermesProfileChat,
  type HermesProfileAgent,
} from './profiles';
import { runHermesRuntimeMaintenance } from './runtime';

type HermesSelectionAgent = HermesProfileAgent & {
  runtime: { id: string; kind: string; sandboxId: string } | null;
};

export async function prepareHermesConversationSelection(
  agent: HermesSelectionAgent,
  selection: HermesConversationSelection,
): Promise<HermesConversationSelection> {
  const profile = normalizeHermesProfile(selection.profile);
  const provider = selection.provider?.trim() || null;
  const model = selection.model?.trim() || null;
  if (
    !profile
    || agent.runtime?.kind !== 'hermes'
    || (provider === null) !== (model === null)
    || (provider !== null && provider.length > 128)
    || (model !== null && model.length > 512)
  ) throw new HermesProfileError('Choose a valid Hermes profile and model.');

  const profiles = await listHermesProfiles(agent);
  if (!profiles.some((item) => item.name === profile)) {
    throw new HermesProfileError('The selected Hermes profile no longer exists.', 404);
  }
  if (!await supportsHermesProfileChat(agent)) {
    throw new HermesProfileError('This Hermes image does not support profile chat routing.', 409);
  }

  let projectedProvider = provider;
  if (provider && model) {
    const projection = await runHermesRuntimeMaintenance(
      agent.workspaceId,
      agent.id,
      agent.runtime.sandboxId,
      { quiesce: false },
      async ({ requestSync }) => {
        const next = await bindHermesAgentModelProvider(agent.workspaceId, agent.id, provider, model);
        requestSync();
        return next;
      },
    );
    if (projection.status === 'error') throw new HermesProfileError(projection.error, 503);
    projectedProvider = projection.data;
    const options = await listHermesProfileModels(agent, profile);
    if (!hasHermesProfileModel(options, projectedProvider, model)) {
      throw new HermesProfileError('The selected model is not available for this Hermes profile.');
    }
  }

  await ensureHermesProfileProjection(agent, profile);
  return { profile, provider: projectedProvider, model };
}
