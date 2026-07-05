import type { Prisma } from '@prisma/client';

export type AgentChannelPairingState = {
  provider: string;
  status: 'waiting' | 'scanned' | 'ready' | 'expired' | 'error';
  qrPayload?: string;
  scanUrl?: string;
  providerSessionId?: string;
  expiresAt?: string;
  requestedAt?: string;
  lastCheckedAt?: string;
  message?: string;
  error?: string;
  extra?: Record<string, string>;
};

function recordValue(value: Prisma.JsonValue | null | undefined): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function textValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function pairingFromConfig(raw: Prisma.JsonValue | null): AgentChannelPairingState | null {
  const config = recordValue(raw);
  const pairing = recordValue(config.pairing as Prisma.JsonValue | null);
  const provider = textValue(pairing.provider);
  const status = textValue(pairing.status) as AgentChannelPairingState['status'] | undefined;
  if (!provider || !status) return null;
  if (!['waiting', 'scanned', 'ready', 'expired', 'error'].includes(status)) return null;
  const extra = recordValue(pairing.extra as Prisma.JsonValue | null);
  return {
    provider,
    status,
    qrPayload: textValue(pairing.qrPayload),
    scanUrl: textValue(pairing.scanUrl),
    providerSessionId: textValue(pairing.providerSessionId),
    expiresAt: textValue(pairing.expiresAt),
    requestedAt: textValue(pairing.requestedAt),
    lastCheckedAt: textValue(pairing.lastCheckedAt),
    message: textValue(pairing.message),
    error: textValue(pairing.error),
    extra: Object.fromEntries(
      Object.entries(extra)
        .map(([key, value]) => [key, textValue(value)])
        .filter((entry): entry is [string, string] => Boolean(entry[1])),
    ),
  };
}

export function configWithPairing(
  raw: Prisma.JsonValue | null,
  pairing: AgentChannelPairingState,
  pairingSecrets?: Prisma.InputJsonValue,
): Prisma.InputJsonValue {
  const config = recordValue(raw);
  return {
    ...config,
    ...(pairingSecrets === undefined ? {} : { pairingSecrets }),
    pairing: {
      provider: pairing.provider,
      status: pairing.status,
      qrPayload: pairing.qrPayload,
      scanUrl: pairing.scanUrl,
      providerSessionId: pairing.providerSessionId,
      expiresAt: pairing.expiresAt,
      requestedAt: pairing.requestedAt,
      lastCheckedAt: pairing.lastCheckedAt,
      message: pairing.message,
      error: pairing.error,
      extra: pairing.extra,
    },
  } as Prisma.InputJsonValue;
}
