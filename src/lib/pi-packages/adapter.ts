// Generated source is reviewed with the package. Credentials remain in a private device file.
export function piPackageMcpAdapterSource(): string {
  return String.raw`import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export default async function toolplaneMcp(pi) {
  // A routing convention set by the trusted host, NOT an extension security boundary.
  const host = globalThis[Symbol.for('toolplane.pi.host-context.v1')];
  if (host?.kind === 'toolplane-sdk' && host.platformMcp === true) return;
  const packageRoot = await realpath(join(dirname(fileURLToPath(import.meta.url)), '..'));
  const root = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'toolplane', 'pi-packages');
  const paths = process.env.TOOLPLANE_PI_CONFIG ? [process.env.TOOLPLANE_PI_CONFIG]
    : (await readdir(root).catch(() => [])).map(id => join(root, id, 'config.json'));
  const matches = [];
  for (const file of paths) {
    let cfg;
    try {
      const info = await stat(file);
      if (info.size > 16384 || (process.platform !== 'win32' && (info.mode & 0o077))) throw new Error('private_config_required');
      cfg = JSON.parse(await readFile(file, 'utf8'));
    } catch { continue; }
    if (cfg.client === 'pi' && cfg.packageRoot && await realpath(cfg.packageRoot).catch(() => '') === packageRoot) matches.push(cfg);
  }
  if (matches.length !== 1) throw new Error('PI_PACKAGE_DEVICE_CONFIG_REQUIRED');
  const cfg = matches[0];
  const base = new URL(cfg.baseUrl);
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))) throw new Error('PI_PACKAGE_INVALID_ORIGIN');
  if (base.username || base.password || base.search || base.hash || !/^[a-zA-Z0-9_-]{1,100}$/.test(cfg.installationId) || !/^tppi_[a-f0-9]{64}$/.test(cfg.token)) throw new Error('PI_PACKAGE_INVALID_CONFIG');
  const endpoint = new URL('/api/v1/pi-packages/installations/' + cfg.installationId + '/mcp', base);
  async function rpc(method, params, signal) {
    const res = await fetch(endpoint, { method: 'POST', redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000), headers: { Authorization: 'Bearer ' + cfg.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    if (!res.ok) throw new Error('PI_PACKAGE_GATEWAY_UNAVAILABLE');
    const reader = res.body.getReader(); let size = 0; const chunks = [];
    try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 4000000) { await reader.cancel(); throw new Error('PI_PACKAGE_RESPONSE_TOO_LARGE'); } chunks.push(value); } } finally { reader.releaseLock(); }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (value.error) throw new Error('PI_PACKAGE_MCP_REQUEST_FAILED');
    return value.result;
  }
  const { tools } = await rpc('tools/list');
  if (!Array.isArray(tools) || tools.length > 1000) throw new Error('PI_PACKAGE_INVALID_CATALOG');
  for (const tool of tools) pi.registerTool({
    name: tool.name, label: tool.title || tool.name,
    description: tool.description || tool.name, parameters: tool.inputSchema,
    async execute(_id, args, signal) {
      const result = await rpc('tools/call', { name: tool.name, arguments: args }, signal);
      if (result.isError) throw new Error('PI_PACKAGE_MCP_TOOL_FAILED');
      const content = (Array.isArray(result.content) ? result.content : []).map(item => {
        if (item?.type === 'text' && typeof item.text === 'string') return { type: 'text', text: item.text };
        if (item?.type === 'image' && typeof item.data === 'string' && typeof item.mimeType === 'string') return { type: 'image', data: item.data, mimeType: item.mimeType };
        return { type: 'text', text: JSON.stringify(item) };
      });
      if (!content.length && result.structuredContent !== undefined) content.push({ type: 'text', text: JSON.stringify(result.structuredContent) });
      return { content, details: { toolplaneOrigin: result._meta?.toolplaneOrigin, structuredContent: result.structuredContent } };
    },
  });
}
`;
}
