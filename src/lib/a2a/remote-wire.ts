/** Validate the supported peer profile before the SDK's permissive protobuf JSON decoder. */
type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid remote protocol value.');
  return value as ObjectValue;
}
function id(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value || value.length > 200 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Invalid remote identifier.');
}
function array(value: unknown, limit: number): unknown[] {
  if (!Array.isArray(value) || value.length > limit) throw new Error('Invalid remote array.');
  return value;
}
function parts(value: unknown) {
  for (const item of array(value, 32)) {
    const part = object(item);
    const kinds = ['text', 'raw', 'url', 'data'].filter((key) => Object.hasOwn(part, key));
    if (kinds.length !== 1 || kinds[0] !== 'text' || typeof part.text !== 'string' || part.text.length > 65_536
      || part.mediaType !== undefined && part.mediaType !== 'text/plain') throw new Error('Unsupported remote part.');
  }
}
function message(value: unknown, taskId?: string, contextId?: string, agentOnly = true) {
  const msg = object(value); id(msg.messageId);
  if (agentOnly ? msg.role !== 'ROLE_AGENT' && msg.role !== 2
    : !['ROLE_AGENT', 'ROLE_USER', 1, 2].includes(msg.role as string | number)) throw new Error('Invalid remote role.');
  parts(msg.parts);
  if (msg.taskId !== undefined && msg.taskId !== '') { id(msg.taskId); if (taskId && taskId !== msg.taskId) throw new Error('Remote task mismatch.'); }
  if (msg.contextId !== undefined && msg.contextId !== '') { id(msg.contextId); if (contextId && contextId !== msg.contextId) throw new Error('Remote context mismatch.'); }
}
function task(value: unknown) {
  const row = object(value); id(row.id); id(row.contextId);
  const status = object(row.status);
  if (!['TASK_STATE_SUBMITTED', 'TASK_STATE_WORKING', 'TASK_STATE_COMPLETED', 'TASK_STATE_FAILED',
    'TASK_STATE_CANCELED', 'TASK_STATE_INPUT_REQUIRED', 'TASK_STATE_REJECTED', 'TASK_STATE_AUTH_REQUIRED',
    1, 2, 3, 4, 5, 6, 7, 8].includes(status.state as string | number)) throw new Error('Invalid remote task state.');
  if (status.message !== undefined) message(status.message, row.id, row.contextId);
  if (status.timestamp !== undefined && (typeof status.timestamp !== 'string' || !Number.isFinite(Date.parse(status.timestamp)))) throw new Error('Invalid remote timestamp.');
  const seen = new Set<string>();
  for (const item of array(row.artifacts ?? [], 16)) {
    const artifact = object(item); id(artifact.artifactId); parts(artifact.parts);
    if (seen.has(artifact.artifactId)) throw new Error('Duplicate remote artifact.');
    seen.add(artifact.artifactId);
  }
  for (const item of array(row.history ?? [], 32)) message(item, row.id, row.contextId, false);
}
export function validateRemoteResponse(request: unknown, response: unknown) {
  const req = object(request), rpc = object(response);
  if (!['SendMessage', 'GetTask', 'CancelTask'].includes(req.method as string) || rpc.jsonrpc !== '2.0'
    || rpc.id !== req.id || Object.hasOwn(rpc, 'error') === Object.hasOwn(rpc, 'result')) throw new Error('Invalid remote JSON-RPC envelope.');
  if (Object.hasOwn(rpc, 'error')) {
    const error = object(rpc.error);
    if (!Number.isSafeInteger(error.code) || typeof error.message !== 'string') throw new Error('Invalid remote protocol error.');
    return;
  }
  if (req.method === 'SendMessage') {
    const result = object(rpc.result);
    if (Object.hasOwn(result, 'task') === Object.hasOwn(result, 'message')) throw new Error('Invalid remote result oneof.');
    if (Object.hasOwn(result, 'task')) task(result.task); else message(result.message);
  } else task(rpc.result);
}
export function validateCardWire(raw: unknown) {
  const card = object(raw);
  if (typeof card.name !== 'string' || typeof card.version !== 'string') throw new Error('Invalid remote Card identity.');
  object(card.capabilities);
  for (const mode of [...array(card.defaultInputModes, 100), ...array(card.defaultOutputModes, 100)]) {
    if (typeof mode !== 'string') throw new Error('Invalid remote media type.');
  }
  for (const item of array(card.supportedInterfaces, 32)) {
    const binding = object(item);
    if (typeof binding.url !== 'string' || typeof binding.protocolBinding !== 'string' || typeof binding.protocolVersion !== 'string'
      || binding.tenant !== undefined && typeof binding.tenant !== 'string') throw new Error('Invalid remote binding.');
  }
  for (const item of array(card.skills, 100)) {
    const skill = object(item); id(skill.id);
    if (typeof skill.name !== 'string') throw new Error('Invalid remote skill.');
  }
  const schemeKinds = ['apiKeySecurityScheme', 'httpAuthSecurityScheme', 'oauth2SecurityScheme', 'openIdConnectSecurityScheme', 'mtlsSecurityScheme'];
  for (const scheme of Object.values(object(card.securitySchemes ?? {}))) {
    const value = object(scheme);
    if (schemeKinds.filter((key) => Object.hasOwn(value, key)).length !== 1) throw new Error('Invalid remote security oneof.');
  }
  for (const item of array(card.securityRequirements ?? [], 32)) {
    for (const scopes of Object.values(object(object(item).schemes))) {
      for (const scope of array(object(scopes).list ?? [], 100)) if (typeof scope !== 'string') throw new Error('Invalid remote security requirement.');
    }
  }
}
