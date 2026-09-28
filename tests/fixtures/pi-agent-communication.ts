import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AgentCard, Task } from '@a2a-js/sdk';
import { JsonRpcTransportHandler, ServerCallContext, type A2ARequestHandler } from '@a2a-js/sdk/server';
import { TaskNotFoundError, UnsupportedOperationError } from '@a2a-js/sdk/errors';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { remoteCard, remoteTask } from './a2a-remote';

export type HttpFixture = { base: string; errors: unknown[]; close(): Promise<void> };
export type RemotePeerFixture = HttpFixture & {
  calls: Array<{ method: string; body: unknown; authorization: string | null }>;
  tasks: Map<string, Task>;
  behavior: { state: string; loseSendResponse: boolean };
};

export async function httpFixture(handler: (request: Request) => Promise<Response>): Promise<HttpFixture> {
  const errors: unknown[] = [];
  const server = createServer((incoming, outgoing) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value)) for (const part of value) headers.append(name, part);
        else if (value !== undefined) headers.set(name, value);
      }
      const request = new Request(`http://${incoming.headers.host}${incoming.url}`, {
        method: incoming.method, headers,
        ...(!['GET', 'HEAD'].includes(incoming.method!) ? { body: Buffer.concat(chunks).toString('utf8') } : {}),
      });
      const response = await handler(request);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    })().catch((error: unknown) => { errors.push(error); outgoing.writeHead(500); outgoing.end('Fixture request failed'); });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not bind a port');
  return { base: `http://127.0.0.1:${address.port}`, errors, async close() {
    server.closeAllConnections();
    await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
    if (errors.length) throw new AggregateError(errors, 'HTTP fixture errors');
  } };
}

/** Official A2A codec and a real HTTP peer; only outbound DNS/TLS routing is replaced by the test. */
export async function remotePeerFixture(): Promise<RemotePeerFixture> {
  const calls: Array<{ method: string; body: unknown; authorization: string | null }> = [];
  const tasks = new Map<string, Task>();
  const behavior = { state: 'TASK_STATE_WORKING', loseSendResponse: false };
  const unsupported = async (): Promise<never> => { throw new UnsupportedOperationError(); };
  const lookup = (id: string) => {
    const task = tasks.get(id);
    if (!task) throw new TaskNotFoundError();
    return Task.fromJSON({ ...remoteTask(behavior.state), id, contextId: task.contextId });
  };
  const handler: A2ARequestHandler = {
    async getAgentCard() { return AgentCard.fromJSON(remoteCard()); },
    async sendMessage() {
      const id = `private-peer-${randomUUID()}`;
      const task = Task.fromJSON({ ...remoteTask(behavior.state), id, contextId: `private-context-${randomUUID()}` });
      tasks.set(id, task);
      return task;
    },
    async getTask(params) { return lookup(params.id); },
    async cancelTask(params) { return lookup(params.id); },
    async *sendMessageStream() { throw new UnsupportedOperationError(); },
    async *resubscribe() { throw new UnsupportedOperationError(); },
    listTasks: unsupported, getAuthenticatedExtendedAgentCard: unsupported,
    createTaskPushNotificationConfig: unsupported, getTaskPushNotificationConfig: unsupported,
    listTaskPushNotificationConfigs: unsupported, deleteTaskPushNotificationConfig: unsupported,
  };
  const rpc = new JsonRpcTransportHandler(handler);
  const server = await httpFixture(async (request) => {
    if (request.method === 'GET') return Response.json(remoteCard());
    const body = await request.json();
    calls.push({ method: body.method, body, authorization: request.headers.get('authorization') });
    const response = await rpc.handle(body, new ServerCallContext({ requestedVersion: request.headers.get('a2a-version') ?? '1.0' }));
    if (Symbol.asyncIterator in response) throw new Error('Unexpected streaming request');
    // The peer accepted and stored work, but its acknowledgement was lost.
    if (body.method === 'SendMessage' && behavior.loseSendResponse) return new Response('Acknowledgement lost', { status: 502 });
    return Response.json(response);
  });
  return { ...server, calls, tasks, behavior };
}

type ModelRequest = { model: string; stream: boolean; messages: Array<{ role: string; content?: unknown; tool_call_id?: string }>; tools?: Array<{ function: { name: string } }> };
type HostOutput = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string };
export type HostEvent = { type: string; operationId?: string; status?: string; text?: string; code?: string; message?: string };
export type HostConfig = { taskId: string; contextId: string; token: string; target?: string; operationId?: string };

function completion(response: ServerResponse, delta: Record<string, unknown>, finish: string) {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const chunk of [
    { choices: [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } },
  ]) response.write(`data: ${JSON.stringify({ id: 'chatcmpl-communication', object: 'chat.completion.chunk', created: 1, model: 'controlled', ...chunk })}\n\n`);
  response.end('data: [DONE]\n\n');
}

/** Runs scripts/pi-harness-session.mjs with the real pinned Harness/SQLite packages, not a TaskExecutor mock. */
export async function nativeHostsFixture(platformBase: string) {
  const root = await mkdtemp(join(tmpdir(), 'pi-agent-communication-'));
  const children = new Set<ChildProcess>();
  const credentials = new Map<string, HostConfig>();
  const modelRequests: ModelRequest[] = [], errors: unknown[] = [];
  let count = 0;
  const marker = `B_NATIVE_OUTPUT_${randomUUID()}`;
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      const token = request.headers.authorization?.replace(/^Bearer /, '') ?? '';
      const config = credentials.get(token);
      if (!config) { response.writeHead(401); response.end(); return; }
      let raw = ''; for await (const chunk of request) raw += String(chunk);
      if (request.url === '/counter') {
        if (request.method !== 'POST') { response.writeHead(405); response.end(); return; }
        const sdk = new Server({ name: 'counted-native-effect', version: '1' }, { capabilities: { tools: {} } });
        sdk.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'count_once', description: 'Record a controlled test effect.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] }));
        sdk.setRequestHandler(CallToolRequestSchema, async (call) => {
          if (call.params.name !== 'count_once' || config.target) throw new Error('Unexpected counter capability');
          count++; return { content: [{ type: 'text', text: marker }], isError: false };
        });
        const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        try {
          await sdk.connect(transport);
          const result = await transport.handleRequest(new Request(`http://${request.headers.host}/counter`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(request.headers['mcp-protocol-version'] ? { 'mcp-protocol-version': String(request.headers['mcp-protocol-version']) } : {}) }, body: raw }));
          response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(Buffer.from(await result.arrayBuffer()));
        } finally { await sdk.close(); }
        return;
      }
      if (request.url !== '/v1/chat/completions') throw new Error('Unexpected controlled model endpoint');
      const body = JSON.parse(raw) as ModelRequest;
      modelRequests.push(body);
      if (!body.stream || body.model !== 'controlled') throw new Error('Expected exact controlled streaming model');
      const toolName = config.target ? 'a2a_call' : 'mcp__s2_t1__count_once';
      const id = config.target ? 'delegate-to-b' : 'count-b-once';
      const result = body.messages.find((message) => message.role === 'tool' && message.tool_call_id === id);
      if (!result) {
        completion(response, { tool_calls: [{ index: 0, id, type: 'function', function: { name: toolName, arguments: JSON.stringify(config.target ? { target: config.target, message: 'Return the counted native output' } : {}) } }] }, 'tool_calls');
      } else {
        if (!JSON.stringify(result.content).includes(marker)) throw new Error('Real child/tool output did not reach the controlled model');
        completion(response, { content: `${config.target ? 'A_RECEIVED_' : ''}${marker}` }, 'stop');
      }
    })().catch((error: unknown) => { errors.push(error); response.writeHead(500); response.end('Controlled model fixture failed'); });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Model fixture did not bind');
  const base = `http://127.0.0.1:${address.port}`;
  const modelsPath = join(root, 'models.json');
  await writeFile(modelsPath, JSON.stringify({ providers: { toolplane: { name: 'Controlled', baseUrl: `${base}/v1`, api: 'openai-completions', apiKey: '$TOOLPLANE_RUNTIME_TOKEN', models: [{ id: 'controlled', name: 'Controlled', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
  async function launch(config: HostConfig, action: 'prepare' | 'run' = 'run') {
    credentials.set(config.token, config);
    const path = join(root, `${randomUUID()}.json`);
    const nativeApprovalUrl = `${platformBase}/api/v1/agent-runtime/a2a/${config.taskId}/approvals`;
    await writeFile(path, JSON.stringify({ action, packageRoot: resolve('.'), directory: join(root, config.contextId), contextId: config.contextId, modelsPath, providerId: 'toolplane', modelId: 'controlled', systemPrompt: 'Use only configured tools.', messages: [{ role: 'user', parts: [{ type: 'text', text: config.target ? 'Delegate to B and include its actual output.' : 'Count once and return the tool output.' }] }], skills: [], disabledBuiltinTools: ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'], maxSteps: 6, workingDirectory: root, legacyStatePath: join(root, `${config.contextId}-legacy.json`), historyRequired: false, communicationEnabled: true, mcpServers: [{ deploymentId: 'toolplane-a2a', url: `${platformBase}/api/v1/agent-runtime/a2a/${config.taskId}/mcp` }, ...(!config.target ? [{ deploymentId: 'counted-native-effect', url: `${base}/counter` }] : [])], nativeApprovalUrl, runtimeAccessToken: config.token, taskId: config.taskId, operationId: config.operationId }));
    const child = spawn(process.execPath, [resolve('scripts/pi-harness-session.mjs'), path], { cwd: resolve('.'), env: { ...process.env, PI_OFFLINE: '1', PI_TELEMETRY: '0', TOOLPLANE_RUNTIME_TOKEN: config.token, TOOLPLANE_APPROVAL_URL: nativeApprovalUrl }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    const done = new Promise<HostOutput>((done, reject) => { child.once('error', reject); child.once('close', (code, signal) => { children.delete(child); done({ code, signal, stdout, stderr }); }); });
    return { child, done };
  }
  function terminal(output: HostOutput, type: 'prepared' | 'result') {
    if (output.code !== 0 || output.signal) throw new Error(`Native host failed: ${output.stdout} ${output.stderr}`);
    const events = output.stdout.trim().split('\n').map((line): HostEvent => JSON.parse(line));
    const result = events.at(-1);
    if (!result || result.type !== type) throw new Error(`Missing ${type} native result`);
    return result;
  }
  return { marker, modelRequests, get count() { return count; }, launch, terminal,
    async prepare(config: HostConfig) { const result = terminal(await (await launch(config, 'prepare')).done, 'prepared'); if (!result.operationId) throw new Error('No native operation ID'); return result.operationId; },
    async close() {
      for (const child of children) { const closed = once(child, 'close'); child.kill('SIGKILL'); await closed; }
      server.closeAllConnections();
      await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
      await rm(root, { recursive: true, force: true });
      if (errors.length) throw new AggregateError(errors, 'Controlled host errors');
    },
  };
}
