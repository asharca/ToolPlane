import { createHash, randomBytes } from 'node:crypto';
import connectorPackage from '../../../packages/connector/package.json';

export const DEFAULT_CONNECTOR_SERVER_URL = 'http://localhost:3000';
export const DEFAULT_CONNECTOR_REMOTE_ROOT = '~/toolplane-sandbox';
export const DEFAULT_CONNECTOR_PACKAGE = '/api/v1/connectors/package.tgz';
export const CONNECTOR_PROTOCOL_VERSION = '2026-07-connector-ws-v2';
export const CONNECTOR_PACKAGE_VERSION = connectorPackage.version;

const LEGACY_CONNECTOR_PACKAGE = `@${['mcp', 'market'].join('-')}/connector`;
const UNPUBLISHED_CONNECTOR_PACKAGE = '@toolplane/connector';
const LEGACY_CONNECTOR_ROOT_SEGMENT = `${['mcp', 'market'].join('')}-sandbox`;
const PORTABLE_COMMAND_ARG = /^[A-Za-z0-9._~:/@+,=?\[\]-]+$/;
const UNSAFE_PORTABLE_QUOTED_ARG = /["$`%!\r\n\0]/;

export type SandboxConnectorConfig = {
  provider: 'websocket';
  protocolVersion: typeof CONNECTOR_PROTOCOL_VERSION;
  serverUrl: string;
  remoteRoot: string;
  tokenHash: string;
  tokenPrefix: string;
  packageName: string;
  createdAt: string;
};

type ConnectorInput = {
  serverUrl?: string | null;
  remoteRoot?: string | null;
  packageName?: string | null;
};

type ConnectorRequestHeaders = {
  get(name: string): string | null;
};

export function defaultConnectorServerUrl(env: Record<string, string | undefined> = process.env): string {
  return sanitizeConnectorServerUrl(env.NEXT_PUBLIC_APP_URL ?? env.APP_URL ?? DEFAULT_CONNECTOR_SERVER_URL);
}

export function connectorServerUrlFromHeaders(
  requestHeaders: ConnectorRequestHeaders,
  env: Record<string, string | undefined> = process.env,
): string {
  const host = (requestHeaders.get('x-forwarded-host') ?? requestHeaders.get('host'))
    ?.split(',')[0]
    ?.trim();
  if (!host) return defaultConnectorServerUrl(env);
  const forwardedProto = requestHeaders.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const localHost = /^(localhost|127\.0\.0\.1|\[::1\])(?::|$)/.test(host);
  return sanitizeConnectorServerUrl(`${forwardedProto || (localHost ? 'http' : 'https')}://${host}`);
}

export function sanitizeConnectorServerUrl(raw: string): string {
  const value = raw.trim() || DEFAULT_CONNECTOR_SERVER_URL;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return DEFAULT_CONNECTOR_SERVER_URL;
    return url.origin;
  } catch {
    return DEFAULT_CONNECTOR_SERVER_URL;
  }
}

export function sanitizeConnectorRoot(raw: string | null | undefined): string {
  const value = String(raw ?? '').trim();
  return value
    && !/^https?:\/\//i.test(value)
    && !UNSAFE_PORTABLE_QUOTED_ARG.test(value)
    ? value
    : DEFAULT_CONNECTOR_REMOTE_ROOT;
}

function normalizeConnectorRoot(raw: string | null | undefined): string {
  return sanitizeConnectorRoot(raw).replaceAll(LEGACY_CONNECTOR_ROOT_SEGMENT, 'toolplane-sandbox');
}

function normalizeConnectorPackage(raw: string | null | undefined): string {
  const value = String(raw ?? '').trim();
  if (!value || value === LEGACY_CONNECTOR_PACKAGE || value === UNPUBLISHED_CONNECTOR_PACKAGE) {
    return DEFAULT_CONNECTOR_PACKAGE;
  }
  return PORTABLE_COMMAND_ARG.test(value) ? value : DEFAULT_CONNECTOR_PACKAGE;
}

function connectorPackageSpec(config: SandboxConnectorConfig): string {
  const value = normalizeConnectorPackage(config.packageName);
  if (!value.startsWith('/')) return value;
  const version = value === DEFAULT_CONNECTOR_PACKAGE ? `?v=${CONNECTOR_PACKAGE_VERSION}` : '';
  return `${sanitizeConnectorServerUrl(config.serverUrl)}${value}${version}`;
}

export function generateConnectorToken(): string {
  return `mcpcon_${randomBytes(32).toString('base64url')}`;
}

export function hashConnectorToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function buildConnectorConfig(input: ConnectorInput, token: string): SandboxConnectorConfig {
  return {
    provider: 'websocket',
    protocolVersion: CONNECTOR_PROTOCOL_VERSION,
    serverUrl: sanitizeConnectorServerUrl(input.serverUrl ?? DEFAULT_CONNECTOR_SERVER_URL),
    remoteRoot: normalizeConnectorRoot(input.remoteRoot),
    tokenHash: hashConnectorToken(token),
    tokenPrefix: token.slice(0, 12),
    packageName: normalizeConnectorPackage(input.packageName),
    createdAt: new Date().toISOString(),
  };
}

export function createConnectorConfig(input: ConnectorInput): {
  token: string;
  config: SandboxConnectorConfig;
} {
  const token = generateConnectorToken();
  return { token, config: buildConnectorConfig(input, token) };
}

function portableCommandArg(value: string): string {
  if (!PORTABLE_COMMAND_ARG.test(value)) {
    throw new Error('Connector command contains an unsupported argument.');
  }
  return value;
}

function portableQuotedArg(value: string): string {
  return `"${portableCommandArg(value)}"`;
}

function portableRootArg(value: string): string {
  return `"${sanitizeConnectorRoot(value)}"`;
}

function connectorClientCommandParts(config: SandboxConnectorConfig, token: string): string[] {
  return [
    'npx',
    '-y',
    '--package',
    portableQuotedArg(connectorPackageSpec(config)),
    'connector',
    'connect',
    '--server',
    portableQuotedArg(config.serverUrl),
    '--token',
    portableQuotedArg(token),
    '--root',
    portableRootArg(config.remoteRoot),
  ];
}

export function connectorClientCommand(config: SandboxConnectorConfig, token: string): string {
  return connectorClientCommandParts(config, token).join(' ');
}

export function isConnectorToken(token: string): boolean {
  return /^mcpcon_[A-Za-z0-9_-]+$/.test(token);
}

export function connectorSourceRef(config: SandboxConnectorConfig): string {
  return `connector://${config.tokenPrefix}${config.remoteRoot.startsWith('/') ? '' : '/'}${config.remoteRoot}`;
}

export function connectorFromConfig(config: unknown): SandboxConnectorConfig | null {
  const cfg = (config ?? {}) as {
    connector?: Partial<SandboxConnectorConfig> & { provider?: string };
  };
  const connector = cfg.connector;
  if (!connector || connector.provider !== 'websocket' || !connector.tokenHash) return null;
  return {
    provider: 'websocket',
    protocolVersion: CONNECTOR_PROTOCOL_VERSION,
    serverUrl: sanitizeConnectorServerUrl(connector.serverUrl ?? DEFAULT_CONNECTOR_SERVER_URL),
    remoteRoot: normalizeConnectorRoot(connector.remoteRoot),
    tokenHash: String(connector.tokenHash),
    tokenPrefix: String(connector.tokenPrefix ?? 'mcpcon_***'),
    packageName: normalizeConnectorPackage(connector.packageName),
    createdAt: String(connector.createdAt ?? ''),
  };
}
