// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { Task, Message } from '@a2a-js/sdk';
import { validateRemoteCard, remoteResult } from '@/lib/a2a/remote-client';
import { validateRemoteResponse } from '@/lib/a2a/remote-wire';
import { REMOTE_RPC, remoteCard, remoteTask } from '../fixtures/a2a-remote';
const request = { jsonrpc: '2.0', id: 'request', method: 'SendMessage' };
const response = (result: unknown) => ({ jsonrpc: '2.0', id: 'request', result });
describe('strict A2A 1.0 remote profile', () => {
  it('selects only the exact declared JSONRPC 1.0 interface', () => {
    const card = remoteCard(); card.supportedInterfaces.push({ url: 'https://other.example/rpc', protocolVersion: '1.0', protocolBinding: 'JSONRPC' });
    expect(validateRemoteCard(card, REMOTE_RPC, true).supportedInterfaces).toHaveLength(1);
    card.supportedInterfaces[0].protocolVersion = '0.3'; expect(() => validateRemoteCard(card, REMOTE_RPC, true)).toThrow();
  });
  it('rejects undeclared targets, missing credentials and required extensions', () => {
    expect(() => validateRemoteCard(remoteCard(), 'https://other.example/rpc', true)).toThrow();
    expect(() => validateRemoteCard(remoteCard(), REMOTE_RPC, false)).toThrow();
    expect(() => validateRemoteCard({ ...remoteCard(), capabilities: { extensions: [{ uri: 'https://extension.example', required: true }] } }, REMOTE_RPC, true)).toThrow();
  });
  it('does not treat OAuth or malformed oneofs as bearer authentication', () => {
    expect(() => validateRemoteCard({ ...remoteCard(), securitySchemes: { service: { oauth2SecurityScheme: { flows: {} } } } }, REMOTE_RPC, true)).toThrow();
    expect(() => validateRemoteCard({ ...remoteCard(), securitySchemes: { service: { httpAuthSecurityScheme: { scheme: 'Bearer' }, apiKeySecurityScheme: { name: 'secret' } } } }, REMOTE_RPC, true)).toThrow();
  });
  it('accepts native task and direct message results without legacy kind fields', () => {
    expect(() => validateRemoteResponse(request, response({ task: remoteTask() }))).not.toThrow();
    const msg = { messageId: 'peer-m', role: 'ROLE_AGENT', parts: [{ text: 'Immediate result' }] };
    expect(() => validateRemoteResponse(request, response({ message: msg }))).not.toThrow();
    expect(remoteResult(Message.fromJSON(msg))).toMatchObject({ state: 3, text: 'Immediate result' });
    expect(remoteResult(Task.fromJSON(remoteTask('TASK_STATE_COMPLETED')))).toMatchObject({ state: 3, taskId: 'peer-task', text: 'Remote review result' });
  });
  it.each([
    { text: 'ok', raw: 'eA==' }, { text: 17 }, { url: 'http://169.254.169.254' }, { data: {} },
    { text: '<script>x</script>', mediaType: 'text/html' }, {},
  ])('rejects unsupported or lossy decoded parts', (part) => {
    expect(() => validateRemoteResponse(request, response({ message: { messageId: 'm', role: 'ROLE_AGENT', parts: [part] } }))).toThrow();
  });
  it('rejects result oneof collisions, wrong IDs, unknown states and a legacy role', () => {
    expect(() => validateRemoteResponse(request, response({ task: remoteTask(), message: {} }))).toThrow();
    expect(() => validateRemoteResponse(request, { ...response({ task: remoteTask() }), id: 'other' })).toThrow();
    expect(() => validateRemoteResponse(request, response({ task: remoteTask('working') }))).toThrow();
    expect(() => validateRemoteResponse(request, response({ message: { messageId: 'm', role: 'agent', parts: [{ text: 'x' }] } }))).toThrow();
  });
  it('enforces total output size after standard decoding', () => {
    const task = remoteTask('TASK_STATE_COMPLETED'); task.artifacts[0].parts[0].text = 'x'.repeat(65_537);
    expect(() => remoteResult(Task.fromJSON(task))).toThrow();
  });
});
