import 'server-only';
import { AgentCard, Message, Task, TaskState, type SendMessageResult } from '@a2a-js/sdk';
import { ClientFactory, JsonRpcTransportFactory } from '@a2a-js/sdk/client';
import { RemoteA2AError, fetchRemoteJson, remotePair, remoteRpcFetch } from './remote-network';
import { validateCardWire } from './remote-wire';
import { A2A_LIMITS, acceptsOutput, textArtifact } from './model';

/** Reject unsupported peer profiles explicitly; never silently select another URL or the v0.3 layer. */
export function validateRemoteCard(raw: unknown, rpcUrl: string, hasCredential: boolean): AgentCard {
  if (!raw || typeof raw !== 'object' || Buffer.byteLength(JSON.stringify(raw)) > 65_536) throw new RemoteA2AError('Invalid or oversized Agent Card.');
  try { validateCardWire(raw); } catch { throw new RemoteA2AError('Invalid remote Agent Card structure.'); }
  const card = AgentCard.fromJSON(raw);
  if (!card.name.trim() || card.name.length > 200 || !card.version || !card.skills.length || card.skills.length > 100
    || !card.defaultInputModes.includes('text/plain') || !card.defaultOutputModes.includes('text/plain')) throw new RemoteA2AError('Remote Agent must declare text/plain input and output.');
  const selected = card.supportedInterfaces.filter((item) => item.url === rpcUrl && item.protocolBinding === 'JSONRPC' && item.protocolVersion === '1.0');
  if (selected.length !== 1 || selected[0].tenant && selected[0].tenant.length > 200) throw new RemoteA2AError('Card must declare the exact approved A2A 1.0 JSONRPC address.');
  if (card.capabilities?.extensions.some((extension) => extension.required)) throw new RemoteA2AError('Required remote extensions are not supported.');
  const alternatives = card.securityRequirements;
  if (alternatives.length && !alternatives.some((requirement) => {
    const names = Object.keys(requirement.schemes);
    if (!names.length) return true;
    const scheme = card.securitySchemes[names[0]]?.scheme;
    return hasCredential && names.length === 1 && requirement.schemes[names[0]].list.length === 0
      && scheme?.$case === 'httpAuthSecurityScheme'
      && scheme.value.scheme.toLowerCase() === 'bearer';
  })) throw new RemoteA2AError('The remote Agent requires an unsupported authentication flow.');
  // A local transport selection, not a signed-card verification or republication of the peer's identity.
  return { ...card, supportedInterfaces: selected };
}
export async function discoverRemoteCard(cardUrl: string, rpcUrl: string, token?: string, signal?: AbortSignal) {
  const pair = remotePair(cardUrl, rpcUrl);
  const response = await fetchRemoteJson(pair.cardUrl, 'GET', undefined, token, signal);
  let raw: unknown;
  try { raw = await response.json(); } catch { throw new RemoteA2AError('Remote Agent Card is not valid JSON.'); }
  return validateRemoteCard(raw, pair.rpcUrl, Boolean(token));
}
export function createRemoteClient(card: AgentCard, rpcUrl: string, token?: string) {
  return new ClientFactory({ transports: [new JsonRpcTransportFactory({ fetchImpl: remoteRpcFetch(rpcUrl, token) })],
    preferredTransports: ['JSONRPC'], clientConfig: { acceptedOutputModes: ['text/plain'] },
  }).createFromAgentCard(validateRemoteCard(AgentCard.toJSON(card), rpcUrl, Boolean(token)));
}
export function remoteText(parts: Message['parts']) {
  if (parts.length > 32 || parts.some((part) => part.content?.$case !== 'text' || !acceptsOutput(['text/plain'], part.mediaType || 'text/plain'))) throw new RemoteA2AError('Remote output is outside the text-only profile.');
  const text = parts.map((part) => part.content?.value ?? '').join('\n');
  if (text.length > A2A_LIMITS.outputCharacters) throw new RemoteA2AError('Remote output limit exceeded.');
  return text;
}
/** Remote task IDs remain private execution bindings; local tasks retain their own identity and history. */
export function remoteResult(result: SendMessageResult | Task) {
  if (!('id' in result)) {
    const message = result as Message;
    if (message.role !== 2 || !message.messageId) throw new RemoteA2AError('Invalid remote message.');
    return { state: TaskState.TASK_STATE_COMPLETED, text: remoteText(message.parts) };
  }
  const task = result as Task;
  if (!task.id || task.id.length > 200 || !task.contextId || task.contextId.length > 200 || !task.status
    || ![1,2,3,4,5,6,7,8].includes(task.status.state) || task.artifacts.length > 16) throw new RemoteA2AError('Invalid remote task.');
  const text = task.artifacts.map((artifact) => remoteText(artifact.parts)).join('\n\n');
  const detail = task.status.message ? remoteText(task.status.message.parts) : '';
  if (text.length + detail.length > A2A_LIMITS.outputCharacters) throw new RemoteA2AError('Remote output limit exceeded.');
  return { state: task.status.state, text, detail: detail.slice(0, 4096), taskId: task.id, contextId: task.contextId };
}
export { textArtifact };
