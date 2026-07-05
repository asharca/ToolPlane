import 'server-only';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

type SecretEnvelope = {
  v: 1;
  alg: 'aes-256-gcm';
  iv: string;
  tag: string;
  data: string;
};

function secretKey() {
  const secret = process.env.AUTH_SECRET || (process.env.NODE_ENV === 'test' ? 'test-secret' : '');
  if (!secret) throw new Error('AUTH_SECRET environment variable is not set');
  return createHash('sha256').update(secret).digest();
}

export function encryptSecretText(value: string): SecretEnvelope {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', secretKey(), iv);
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return {
    v: 1,
    alg: 'aes-256-gcm',
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    data: data.toString('base64url'),
  };
}

export function decryptSecretText(raw: unknown): string {
  const envelope = raw as Partial<SecretEnvelope>;
  if (
    !envelope
    || envelope.v !== 1
    || envelope.alg !== 'aes-256-gcm'
    || typeof envelope.iv !== 'string'
    || typeof envelope.tag !== 'string'
    || typeof envelope.data !== 'string'
  ) {
    throw new Error('Invalid secret envelope');
  }
  const decipher = createDecipheriv(
    'aes-256-gcm',
    secretKey(),
    Buffer.from(envelope.iv, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.data, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

export function encryptSecretRecord(values: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, encryptSecretText(value)]),
  );
}

export function decryptSecretRecord(raw: unknown): Record<string, string> {
  const record = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, decryptSecretText(value)]),
  );
}
