const encoder = new TextEncoder();

export function encodeSseEvent(event: string, data: unknown, id?: number | string): Uint8Array {
  const lines = [
    ...(id === undefined ? [] : [`id: ${id}`]),
    `event: ${event}`,
    ...JSON.stringify(data).split('\n').map((line) => `data: ${line}`),
    '',
    '',
  ];
  return encoder.encode(lines.join('\n'));
}

export function encodeSseDone(): Uint8Array {
  return encoder.encode('data: [DONE]\n\n');
}

export function encodeSseHeartbeat(): Uint8Array {
  return encoder.encode(': heartbeat\n\n');
}

export const AGENT_API_SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'private, no-store, no-cache, must-revalidate',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
} as const;

export type AgentApiResponseView = {
  id: string;
  object: 'agent.response';
  created_at: number;
  endpoint_id: string;
  endpoint_revision: number;
  conversation_id: string | null;
  status: string;
  output: Array<{
    type: 'message';
    role: 'assistant';
    content: Array<{ type: 'output_text'; text: string }>;
  }>;
  output_text: string;
  usage: {
    input_characters: number;
    output_characters: number;
    duration_ms: number;
  };
  request_id: string;
  error?: { code: string; message: string };
};
