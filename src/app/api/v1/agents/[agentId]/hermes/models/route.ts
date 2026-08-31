import { resolveRequestUser } from '@/lib/auth/request-user';
import { getAgentForRequest, listProviders } from '@/lib/agents/queries';
import { hermesProviderName } from '@/lib/agents/hermes/config';
import {
  HermesProfileError,
  listHermesProfiles,
  normalizeHermesProfile,
} from '@/lib/agents/hermes/profiles';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  req: Request,
  { params }: { params: Promise<{ agentId: string }> },
) {
  const user = await resolveRequestUser(req);
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const { agentId } = await params;
  const agent = await getAgentForRequest(agentId, user.id);
  if (!agent) return Response.json({ error: 'Agent not found' }, { status: 404 });
  if (agent.runtime?.kind !== 'hermes') {
    return Response.json({ error: 'Hermes runtime is not configured.' }, { status: 409 });
  }
  const profile = normalizeHermesProfile(new URL(req.url).searchParams.get('profile'));
  if (!profile) return Response.json({ error: 'Invalid Hermes profile.' }, { status: 400 });
  try {
    const [profiles, configuredProviders] = await Promise.all([
      listHermesProfiles(agent),
      listProviders(agent.workspaceId),
    ]);
    const current = profiles.find((item) => item.name === profile);
    if (!current) throw new HermesProfileError('The selected Hermes profile no longer exists.', 404);
    const providers = configuredProviders.flatMap((provider) => provider.models.length ? [{
      id: hermesProviderName(provider.id),
      name: provider.name,
      models: provider.models,
      modelRecords: provider.modelRecords.map((model) => ({
        modelId: model.modelId,
        primaryType: model.primaryType,
        capabilities: model.capabilities,
        inputModalities: model.inputModalities,
      })),
    }] : []);
    const currentProvider = current.provider?.replace(/^custom:/, '') ?? null;
    const selected = currentProvider && current.model
      ? providers.find((provider) => (
          provider.id === currentProvider && provider.models.includes(current.model!)
        ))
      : null;
    return Response.json({
      profile,
      provider: selected?.id ?? null,
      model: selected ? current.model : null,
      providers,
    });
  } catch (error) {
    if (error instanceof HermesProfileError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    return Response.json({ error: 'Hermes models are unavailable.' }, { status: 502 });
  }
}
