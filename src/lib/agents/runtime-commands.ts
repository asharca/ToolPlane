import { z } from 'zod';

export const RUNTIME_COMMANDS_PART = 'data-runtime-commands';
export const COMMAND_RESULT_PART = 'data-command-result';
export const RUNTIME_USAGE_PART = 'data-runtime-usage';
export const RuntimeCommandSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_:-]{0,99}$/i),
  description: z.string().max(1000).optional(),
}).strict();
export const RuntimeCommandsSchema = z.array(RuntimeCommandSchema).max(200);
export type RuntimeCommand = z.infer<typeof RuntimeCommandSchema>;
export type RuntimeCommandResult = { command: string; text: string; status: 'completed' | 'failed' };
export type ParsedRuntimeCommand = { name: string; args: string };

// Cherry's fallback catalogs. Live commands supplement these only for the same runtime/session.
const BUILTINS: Record<string, readonly string[]> = {
  pi: ['compact'],
  'pi-sdk': ['compact'],
  'claude-code': ['clear', 'compact', 'context', 'usage'],
  dsh: ['compact', 'goal'],
  hermes: ['compact'],
  'hermes-rpc': ['compact'],
};
export const HOST_ONLY_COMMAND_NAMES = ['new', 'help', 'whoami', 'effort', 'fast'] as const;
const HOST_ONLY: Record<string, true> = Object.fromEntries(HOST_ONLY_COMMAND_NAMES.map((name) => [name, true]));
export function runtimeCommands(runtimeKind: string, live: readonly RuntimeCommand[] = []): RuntimeCommand[] {
  const builtins = BUILTINS[runtimeKind] ?? [];
  if (!builtins.length) return [];
  const extra = runtimeKind === 'claude-code' || runtimeKind === 'dsh' || runtimeKind === 'pi-sdk' ? live : [];
  return [...new Map([...builtins.map((name) => ({ name })), ...extra.filter((command) => !Object.hasOwn(HOST_ONLY, command.name) && !builtins.includes(command.name))].map((command) => [command.name, command])).values()];
}

export function parseRuntimeCommand(text: string, runtimeKind: string): ParsedRuntimeCommand | null {
  const match = text.trim().match(/^\/([a-z][a-z0-9_:-]{0,99})(?:\s+([\s\S]*))?$/i);
  return match ? { name: runtimeKind === 'pi-sdk' ? match[1] : match[1].toLowerCase(), args: match[2]?.trim() ?? '' } : null;
}

export function sessionRuntimeCommands(runtimeKind: string, messages: readonly { parts: unknown }[]) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const parts = messages[i].parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if (part?.type !== RUNTIME_COMMANDS_PART || part.data?.runtimeKind !== runtimeKind) continue;
      const parsed = RuntimeCommandsSchema.safeParse(part.data.commands);
      if (parsed.success) return runtimeCommands(runtimeKind, parsed.data);
    }
  }
  return runtimeCommands(runtimeKind);
}

export type RuntimeUsage = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd?: number };
export function parseRuntimeUsage(value: unknown): RuntimeUsage | null {
  const parsed = z.object({ inputTokens: z.number().nonnegative(), outputTokens: z.number().nonnegative(), cacheReadTokens: z.number().nonnegative(), cacheWriteTokens: z.number().nonnegative(), costUsd: z.number().nonnegative().optional() }).safeParse(value);
  return parsed.success ? parsed.data : null;
}
