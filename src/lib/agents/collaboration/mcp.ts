import 'server-only';
import { z } from 'zod';
import { COLLABORATION_TOOLS, DelegateInput, ContinueInput, TaskInput, GetInput, QuestionInput, ArtifactInput,
  CollaborationError, terminal } from './protocol';
import { listDelegateAgents, submitDelegation, getDelegation, continueDelegation, cancelDelegation, currentTask,
  updateCurrentTask, type CollaborationPrincipal } from './service';
import { readCollaborationJson, collaborationJson } from './http';

type RuntimePrincipal = Extract<CollaborationPrincipal, { kind: 'runtime' }>;
const Empty = z.object({}).strict();
const Rpc = z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.string().max(128), z.number().int().safe(), z.null()]).optional(),
  method: z.string().min(1).max(128), params: z.record(z.string(), z.unknown()).optional() }).strict();
const calls = new Map<string, { count: number; until: number }>();
export function collaborationAdmission(id: string, now = Date.now()) {
  if (calls.size >= 4096) for (const [key, value] of calls) if (value.until <= now) calls.delete(key);
  const entry = calls.get(id);
  if (!entry || entry.until <= now) {
    if (calls.size >= 4096 && !entry) throw new CollaborationError('rate_limit', 'Collaboration request capacity reached.', 429);
    calls.set(id, { count: 1, until: now + 60_000 }); return;
  }
  if (++entry.count > 120) throw new CollaborationError('rate_limit', 'Too many collaboration requests.', 429);
}
export async function executeCollaborationTool(principal: RuntimePrincipal, name: string, raw: unknown, signal?: AbortSignal) {
  switch (name) {
    case 'list_delegate_agents': Empty.parse(raw); return { agents: await listDelegateAgents(principal) };
    case 'delegate_to_agent': return submitDelegation(principal, DelegateInput.parse(raw));
    case 'continue_delegation': return continueDelegation(principal, ContinueInput.parse(raw));
    case 'cancel_delegation': return cancelDelegation(principal, TaskInput.parse(raw).taskId);
    case 'get_current_delegation': Empty.parse(raw); return { task: await currentTask(principal) };
    case 'request_delegation_input': return updateCurrentTask(principal, QuestionInput.parse(raw));
    case 'publish_delegation_artifact': return updateCurrentTask(principal, ArtifactInput.parse(raw));
    case 'get_delegation': {
      const input = GetInput.parse(raw);
      let task = await getDelegation(principal, input.taskId);
      const initial = task.status.timestamp;
      const end = Date.now() + (input.waitSeconds ?? 0) * 1000;
      while (Date.now() < end && task.status.timestamp === initial && !terminal(task.status.state)
        && task.status.state !== 'auth-required' && task.status.state !== 'input-required') {
        signal?.throwIfAborted();
        await new Promise((resolve) => setTimeout(resolve, Math.min(500, end - Date.now())));
        task = await getDelegation(principal, input.taskId);
      }
      return task;
    }
    default: throw new CollaborationError('unknown_tool', 'Unknown collaboration tool.');
  }
}
export async function handleCollaborationMcp(req: Request, principal: RuntimePrincipal) {
  let id: string | number | null = null;
  try {
    collaborationAdmission(principal.runId);
    const raw = await readCollaborationJson(req);
    const serialized = JSON.stringify(raw);
    const credentials = [req.headers.get('authorization')?.replace(/^Bearer\s+/i, ''),
      req.headers.get('x-toolplane-runtime-token'), req.headers.get('x-api-key')].filter((value): value is string => Boolean(value && value.length > 10));
    if (credentials.some((value) => serialized.includes(value))) throw new CollaborationError('credential_in_payload', 'Runtime credentials must not be included in task content.');
    const message = Rpc.parse(raw);
    id = message.id ?? null;
    if (message.id === undefined) {
      if (message.method === 'notifications/initialized') return new Response(null, { status: 202 });
      // Notifications cannot invoke tools or mutate tasks.
      return new Response(null, { status: 202 });
    }
    let result: unknown;
    if (message.method === 'initialize') result = {
      protocolVersion: message.params?.protocolVersion === '2025-11-25' ? '2025-11-25' : '2025-06-18',
      capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'toolplane-collaboration', version: '1.0.0' },
    };
    else if (message.method === 'ping') result = {};
    else if (message.method === 'tools/list') result = { tools: COLLABORATION_TOOLS };
    else if (message.method === 'tools/call') {
      const args = z.object({ name: z.string().max(128), arguments: z.unknown().optional(), _meta: z.unknown().optional() }).strict().parse(message.params);
      try {
        const output = await executeCollaborationTool(principal, args.name, args.arguments ?? {}, req.signal);
        result = { content: [{ type: 'text', text: JSON.stringify(output) }], isError: false };
      } catch (error) {
        result = { content: [{ type: 'text', text: JSON.stringify(error instanceof CollaborationError
          ? { error: error.code, message: error.message } : error instanceof z.ZodError
            ? { error: 'invalid_arguments', message: 'Invalid tool arguments.' }
            : { error: 'unavailable', message: 'Collaboration operation failed.' }) }], isError: true };
      }
    } else return collaborationJson({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found.' } });
    return collaborationJson({ jsonrpc: '2.0', id, result });
  } catch (error) {
    return collaborationJson({ jsonrpc: '2.0', id, error: { code: -32600,
      message: error instanceof CollaborationError ? error.message : 'Invalid JSON-RPC request.' } }, error instanceof CollaborationError ? error.status : 400);
  }
}
