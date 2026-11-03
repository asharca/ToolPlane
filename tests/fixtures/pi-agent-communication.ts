import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { AgentCard, Task } from '@a2a-js/sdk';
import { JsonRpcTransportHandler, ServerCallContext, type A2ARequestHandler } from '@a2a-js/sdk/server';
import { TaskNotFoundError, UnsupportedOperationError } from '@a2a-js/sdk/errors';
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

