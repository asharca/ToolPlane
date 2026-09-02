function hasExplicitHttpsPort(value: string): boolean {
  const authority = /^https:\/\/([^/?#]+)/i.exec(value)?.[1] ?? '';
  const host = authority.slice(authority.lastIndexOf('@') + 1);
  return host.startsWith('[') ? /^\]:/.test(host.slice(host.indexOf(']'))) : host.includes(':');
}

function blockedIpv4(address: string): boolean {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b, c] = octets;
  return a === 0
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 0 && c === 2)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224;
}

function blockedIpv6(address: string): boolean {
  const normalized = address.toLowerCase().split('%')[0];
  const dotted = normalized.match(/(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (dotted && normalized.startsWith('::')) return blockedIpv4(dotted);
  if (normalized.startsWith('::ffff:')) {
    const words = normalized.slice(7).split(':');
    if (words.length === 2 && words.every((word) => /^[0-9a-f]{1,4}$/.test(word))) {
      const high = Number.parseInt(words[0], 16);
      const low = Number.parseInt(words[1], 16);
      return blockedIpv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
    }
  }
  const first = Number.parseInt(normalized.split(':')[0] || '0', 16);
  return normalized === '::'
    || normalized === '::1'
    || (first & 0xffc0) === 0xfe80
    || (first & 0xffc0) === 0xfec0
    || (first & 0xff00) === 0xff00
    || normalized.startsWith('64:ff9b:')
    || normalized.startsWith('100:')
    || normalized.startsWith('2001:db8:');
}

export function isValidRemoteMcpUrl(value: string): boolean {
  if (!value || value.length > 2_048) return false;
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:'
      || url.username
      || url.password
      || url.search
      || url.hash
      || url.port
      || hasExplicitHttpsPort(value)
    ) return false;
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false;
    return host.includes(':') ? !blockedIpv6(host) : !blockedIpv4(host);
  } catch {
    return false;
  }
}
