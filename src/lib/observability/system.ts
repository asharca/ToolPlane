import 'server-only';
import { recordEvent } from './events';

export function systemLog(level: 'info' | 'warn' | 'error' | 'debug', message: unknown, ...args: unknown[]) {
  void recordEvent({ domain: 'system', eventName: `system.${level}`, level,
    message: typeof message === 'string' ? message : 'System event',
    error: [message, ...args].find((value) => value instanceof Error),
    outcome: level === 'error' ? 'error' : undefined, attributes: args.filter((value) => !(value instanceof Error)) });
}
