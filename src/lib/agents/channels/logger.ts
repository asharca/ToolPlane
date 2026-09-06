export type ChannelLogger = Record<'debug' | 'info' | 'warn' | 'error', (message: string, meta?: unknown) => void>;

export const loggerService = {
  withContext(context: string): ChannelLogger {
    // Raw platform metadata can contain tokens. Per-channel errors are reported
    // through the adapter and redacted by the channel manager instead.
    const log = (message: string) => console.info(`[${context}] ${message}`);
    return { debug: log, info: log, warn: log, error: log };
  },
};
