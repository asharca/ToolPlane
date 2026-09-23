export const REMOTE_RPC = 'https://agent.example/a2a';
export const REMOTE_CARD = 'https://agent.example/.well-known/agent-card.json';
export const remoteCard = () => ({ name: 'Remote reviewer', description: 'Fixture', version: '1',
  supportedInterfaces: [{ url: REMOTE_RPC, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
  capabilities: { streaming: false }, defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'],
  skills: [{ id: 'review', name: 'Review', description: 'Review supplied content', tags: ['review'] }],
  securitySchemes: { service: { httpAuthSecurityScheme: { scheme: 'Bearer' } } },
  securityRequirements: [{ schemes: { service: { list: [] } } }],
});
export const remoteTask = (state = 'TASK_STATE_WORKING', detail?: string) => ({ id: 'peer-task', contextId: 'peer-context',
  status: { state, ...(detail ? { message: { messageId: 'peer-message', taskId: 'peer-task', contextId: 'peer-context', role: 'ROLE_AGENT', parts: [{ text: detail }] } } : {}) },
  artifacts: state === 'TASK_STATE_COMPLETED' ? [{ artifactId: 'review', parts: [{ text: 'Remote review result' }] }] : [],
});
