import { isIP } from 'node:net';

export const MAX_REMOTE_MCP_PRIVATE_HOSTS_LENGTH = 8_192;
export const MAX_REMOTE_MCP_PRIVATE_HOSTS = 100;

const DNS_HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

export function normalizeRemoteMcpHostname(value) {
  return value.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

function privateIpv4(address) {
  const [a, b] = address.split('.').map(Number);
  return a === 10
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168);
}

function privateIpv6(address) {
  const normalized = address.toLowerCase().split('%')[0];
  const dotted = normalized.match(/(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (dotted && normalized.startsWith('::')) return privateIpv4(dotted);
  if (normalized.startsWith('::ffff:')) {
    const words = normalized.slice(7).split(':');
    if (words.length === 2 && words.every((word) => /^[0-9a-f]{1,4}$/.test(word))) {
      const high = Number.parseInt(words[0], 16);
      const low = Number.parseInt(words[1], 16);
      return privateIpv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
    }
  }
  const first = Number.parseInt(normalized.split(':')[0] || '0', 16);
  return (first & 0xfe00) === 0xfc00;
}

export function isPrivateRemoteMcpIp(address) {
  const family = isIP(address);
  return family === 4 ? privateIpv4(address) : family === 6 ? privateIpv6(address) : false;
}

export function parseRemoteMcpPrivateHosts(value) {
  if (typeof value !== 'string' || value.length > MAX_REMOTE_MCP_PRIVATE_HOSTS_LENGTH) return null;

  const entries = new Set();
  const hosts = new Set();
  const suffixes = new Set();
  const ips = new Set();
  for (const entry of value.split(/[\r\n,]/)) {
    const target = normalizeRemoteMcpHostname(entry.trim());
    if (!target) continue;

    if (target.startsWith('*.')) {
      const suffix = target.slice(2);
      if (!DNS_HOST_RE.test(suffix) || isIP(suffix) || suffix.endsWith('.localhost') || suffix.endsWith('.local')) {
        return null;
      }
      entries.add(`*.${suffix}`);
      suffixes.add(suffix);
    } else if (isIP(target)) {
      if (!isPrivateRemoteMcpIp(target)) return null;
      entries.add(target);
      ips.add(target);
    } else if (!DNS_HOST_RE.test(target)
      || target === 'localhost'
      || target.endsWith('.localhost')
      || target.endsWith('.local')) {
      return null;
    } else {
      entries.add(target);
      hosts.add(target);
    }

    if (entries.size > MAX_REMOTE_MCP_PRIVATE_HOSTS) return null;
  }

  return { value: [...entries].join(','), hosts, suffixes, ips };
}
