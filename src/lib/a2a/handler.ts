import 'server-only';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentCard, Task, StreamResponse, type SendMessageRequest, type GetTaskRequest,
  type CancelTaskRequest, type SubscribeToTaskRequest, type ListTasksRequest } from '@a2a-js/sdk';
import { type A2ARequestHandler, type ServerCallContext } from '@a2a-js/sdk/server';
import { PushNotificationNotSupportedError, ExtendedAgentCardNotConfiguredError, TaskNotFoundError, UnsupportedOperationError } from '@a2a-js/sdk/errors';
import { db } from '@/lib/db';
import { runtimeEnv } from '@/lib/runtime-env';
import { assertRuntimeOwner } from '@/lib/runtime/ownership-state';
import { A2A_PROTOCOL_VERSION, A2A_LIMITS, historyView, settled, terminal, taskEvent } from './model';
import { assertLiveGrant, type A2AGrant, type A2AOperation } from './principal';
import * as store from './store';
import { wakeA2AWorker } from './worker';

export async function buildAgentCard(grant: A2AGrant): Promise<AgentCard> {
  const endpoint = await db.agentEndpoint.findFirstOrThrow({ where: { id: grant.endpointId,
    a2aEnabled: true, status: 'active', workspaceId: grant.workspaceId },
    select: { name: true, publicId: true, currentRevision: { select: { version: true } } } });
  const base = new URL(runtimeEnv('NEXT_PUBLIC_APP_URL') || 'http://localhost:3000');
  if (base.username || base.password || !['http:', 'https:'].includes(base.protocol)) throw new Error('Invalid public A2A origin');
  if (base.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) throw new Error('A2A requires HTTPS outside loopback');
  const url = new URL(`/api/v1/agent-endpoints/${encodeURIComponent(endpoint.publicId)}/a2a`, base).href;
  return AgentCard.fromJSON({ name: endpoint.name, description: 'An explicitly published ToolPlane Agent service.',
    version: String(endpoint.currentRevision?.version ?? 1),
    supportedInterfaces: [{ url, protocolBinding: 'JSONRPC', protocolVersion: A2A_PROTOCOL_VERSION }],
    capabilities: { streaming: true, pushNotifications: false, extendedAgentCard: false },
    defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'],
    skills: [{ id: 'execute', name: endpoint.name, description: 'Execute a text task using this published service.', tags: ['agent'] }],
    securitySchemes: { bearer: { httpAuthSecurityScheme: {
      scheme: 'Bearer', bearerFormat: 'ToolPlane Endpoint credential', description: 'Requires explicitly granted A2A permissions.',
    } } }, securityRequirements: [{ schemes: { bearer: { list: [] } } }],
  });
}
export class NativeA2AHandler implements A2ARequestHandler {
  constructor(private readonly grant: A2AGrant, private readonly card: AgentCard, private readonly signal?: AbortSignal,
    private readonly wake: () => void = wakeA2AWorker) {}
  async getAgentCard() { return this.card; }
  private async authorize(context: ServerCallContext, operation: A2AOperation) {
    if (context.tenant && context.tenant !== this.grant.endpointPublicId) throw new TaskNotFoundError();
    await assertLiveGrant(this.grant, operation);
  }
  async sendMessage(params: SendMessageRequest, context: ServerCallContext) {
    assertRuntimeOwner(); await this.authorize(context, 'send');
    const row = await store.submitTask(this.grant, params); this.wake();
    if (params.configuration?.returnImmediately) return historyView(Task.fromJSON(row.snapshot), params.configuration.historyLength);
    return this.waitForTask(row.id, 'send', params.configuration?.historyLength);
  }
  async *sendMessageStream(params: SendMessageRequest, context: ServerCallContext) {
    assertRuntimeOwner(); await this.authorize(context, 'send');
    const row = await store.submitTask(this.grant, params); this.wake();
    yield* this.events(row.id, 'send', params.configuration?.historyLength);
  }
  async getTask(params: GetTaskRequest, context: ServerCallContext) {
    await this.authorize(context, 'read'); return store.getTask(this.grant, params.id, params.historyLength);
  }
  async listTasks(params: ListTasksRequest, context: ServerCallContext) {
    await this.authorize(context, 'read'); return store.listTasks(this.grant, params);
  }
  async cancelTask(params: CancelTaskRequest, context: ServerCallContext) {
    assertRuntimeOwner(); await this.authorize(context, 'cancel');
    await store.requestCancellation(this.grant, params.id); this.wake();
    return this.waitForTask(params.id, 'cancel');
  }
  async *resubscribe(params: SubscribeToTaskRequest, context: ServerCallContext) {
    await this.authorize(context, 'read'); yield* this.events(params.id, 'read', undefined, true);
  }
  private async waitForTask(id: string, operation: A2AOperation, historyLength?: number) {
    while (true) {
      this.signal?.throwIfAborted(); await assertLiveGrant(this.grant, operation);
      const task = await store.getTask(this.grant, id, historyLength);
      if (task.status && settled(task.status.state)) return task;
      await delay(A2A_LIMITS.pollMs, undefined, { signal: this.signal });
    }
  }
  private async *events(id: string, operation: A2AOperation, historyLength?: number, subscribe = false): AsyncGenerator<StreamResponse> {
    const row = await store.getTaskRow(this.grant, id);
    let sequence = row.sequence;
    const initial = historyView(Task.fromJSON(row.snapshot), historyLength);
    if (subscribe && initial.status && terminal(initial.status.state)) throw new UnsupportedOperationError('A terminal task cannot be subscribed to. Use GetTask.');
    // Every subscription begins with an authoritative snapshot, not an assumed event replay.
    yield taskEvent(initial);
    if (initial.status && settled(initial.status.state)) return;
    while (true) {
      this.signal?.throwIfAborted(); await assertLiveGrant(this.grant, operation);
      for (const event of await store.eventsAfter(this.grant, id, sequence)) {
        sequence = event.sequence;
        const payload = StreamResponse.fromJSON(event.payload);
        if (payload.payload?.$case === 'task') payload.payload.value = historyView(payload.payload.value, historyLength);
        yield payload;
        if (payload.payload?.$case === 'statusUpdate' && payload.payload.value.status && settled(payload.payload.value.status.state)) return;
      }
      await delay(A2A_LIMITS.pollMs, undefined, { signal: this.signal });
    }
  }
  async getAuthenticatedExtendedAgentCard(): Promise<never> { throw new ExtendedAgentCardNotConfiguredError(); }
  async createTaskPushNotificationConfig(): Promise<never> { throw new PushNotificationNotSupportedError(); }
  async getTaskPushNotificationConfig(): Promise<never> { throw new PushNotificationNotSupportedError(); }
  async listTaskPushNotificationConfigs(): Promise<never> { throw new PushNotificationNotSupportedError(); }
  async deleteTaskPushNotificationConfig(): Promise<never> { throw new PushNotificationNotSupportedError(); }
}
