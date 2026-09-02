import 'server-only';

import { mcpRpc } from './mcp-client';
import { parseMcpToolCatalogResult, type McpToolDefinition } from './mcp-tool-catalog';
import type { SpawnSpec } from './spawn-spec';

type RemoteSpec = Extract<SpawnSpec, { kind: 'remote' }>;

const MAX_PAGES = 10;
const MAX_TOOLS = 1_000;

export class SandboxMcpAuthenticationError extends Error {
  constructor() {
    super('The remote MCP rejected its credentials.');
    this.name = 'SandboxMcpAuthenticationError';
  }
}

// Runs with `node -e` inside the selected sandbox. Configuration and secrets
// are supplied on stdin so they never enter the process argv or runtime logs.
const BOOTSTRAP = "let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{const i=s.indexOf('\\n');globalThis.__MCP_CONFIG=JSON.parse(s.slice(0,i));(0,eval)(s.slice(i+1))})";

const CLIENT = String.raw`(async()=>{
const c=globalThis.__MCP_CONFIG,base=new URL(c.url),dns=require('node:dns').promises,net=require('node:net'),norm=h=>String(h).toLowerCase().replace(/^\[|\]$/g,'').replace(/\.$/,''),targets=typeof c.privateHosts==='string'?c.privateHosts.split(',').filter(Boolean):[];
const blocked4=a=>{const p=a.split('.').map(Number),[x,y,z]=p;return p.length!==4||p.some(n=>!Number.isInteger(n)||n<0||n>255)||x===0||x===10||x===127||(x===100&&y>=64&&y<=127)||(x===169&&y===254)||(x===172&&y>=16&&y<=31)||(x===192&&y===0&&z===0)||(x===192&&y===0&&z===2)||(x===192&&y===168)||(x===198&&(y===18||y===19))||(x===198&&y===51&&z===100)||(x===203&&y===0&&z===113)||x>=224};
const blocked6=a=>{a=a.toLowerCase().split('%')[0];const d=a.match(/(\d+\.\d+\.\d+\.\d+)$/)?.[1];if(d&&a.startsWith('::'))return blocked4(d);if(a.startsWith('::ffff:')){const w=a.slice(7).split(':');if(w.length===2&&w.every(x=>/^[0-9a-f]{1,4}$/.test(x))){const h=parseInt(w[0],16),l=parseInt(w[1],16);return blocked4((h>>8)+'.'+(h&255)+'.'+(l>>8)+'.'+(l&255))}}const f=parseInt(a.split(':')[0]||'0',16);return a==='::'||a==='::1'||(f&0xfe00)===0xfc00||(f&0xffc0)===0xfe80||(f&0xffc0)===0xfec0||(f&0xff00)===0xff00||a.startsWith('64:ff9b:')||a.startsWith('100:')||a.startsWith('2001:db8:')};
const private4=a=>{const p=a.split('.').map(Number),[x,y]=p;return p.length===4&&p.every(n=>Number.isInteger(n)&&n>=0&&n<=255)&&(x===10||(x===172&&y>=16&&y<=31)||(x===192&&y===168))};
const private6=a=>{a=a.toLowerCase().split('%')[0];const d=a.match(/(\d+\.\d+\.\d+\.\d+)$/)?.[1];if(d&&a.startsWith('::'))return private4(d);if(a.startsWith('::ffff:')){const w=a.slice(7).split(':');if(w.length===2&&w.every(x=>/^[0-9a-f]{1,4}$/.test(x))){const h=parseInt(w[0],16),l=parseInt(w[1],16);return private4((h>>8)+'.'+(h&255)+'.'+(l>>8)+'.'+(l&255))}}return(parseInt(a.split(':')[0]||'0',16)&0xfe00)===0xfc00};
const allowedPrivate=(h,a)=>{const f=net.isIP(a);return(f===4?private4(a):f===6&&private6(a))&&(targets.includes(h)||targets.some(x=>x.startsWith('*.')&&h.endsWith('.'+x.slice(2))))};
async function safe(u,query=false){u=new URL(u);if(u.protocol!=='https:'||u.origin!==base.origin||u.username||u.password||u.port||(!query&&u.search)||u.hash)throw Error('Remote endpoint is not allowed');const h=norm(u.hostname),a=await dns.lookup(h,{all:true,verbatim:true});if(!a.length||a.some(x=>{const f=net.isIP(x.address);return(f===4?blocked4(x.address):blocked6(x.address))&&!allowedPrivate(h,x.address)}))throw Error('Remote endpoint is not public');return u}
const headers={...c.headers,accept:'application/json, text/event-stream','content-type':'application/json'};
async function body(r){const max=120000,n=Number(r.headers.get('content-length')||0);if(n>max)throw Error('Remote MCP response too large');if(!r.body)return '';const q=r.body.getReader(),d=new TextDecoder();let out='',size=0;for(;;){const x=await q.read();if(x.done)break;size+=x.value.byteLength;if(size>max){await q.cancel();throw Error('Remote MCP response too large')}out+=d.decode(x.value,{stream:true})}return out+d.decode()}
function payload(text,id){let values=[];try{values=[JSON.parse(text)]}catch{for(const b of text.split(/\r?\n\r?\n/)){const d=b.split(/\r?\n/).filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trim()).join('\n');if(d)try{values.push(JSON.parse(d))}catch{}}}const v=values.find(x=>x&&x.id===id);if(!v)throw Error('Remote MCP returned no response');if(v.error)throw Error(String(v.error.message||'Remote MCP error'));return v.result}
async function streamable(){let session,protocol='2025-06-18';async function post(msg){const u=await safe(base),h={...headers,...(session?{'mcp-session-id':session}:{}),...(protocol?{'mcp-protocol-version':protocol}:{})},r=await fetch(u,{method:'POST',headers:h,body:JSON.stringify(msg),redirect:'error',signal:AbortSignal.timeout(c.timeoutMs)});session=r.headers.get('mcp-session-id')||session;if(!r.ok)throw Error('Remote MCP request failed ('+r.status+')');if(msg.id==null)return null;return payload(await body(r),msg.id)}const init=await post({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:protocol,capabilities:{},clientInfo:{name:'toolplane-sandbox-inspector',version:'1.0.0'}}});protocol=init?.protocolVersion||protocol;await post({jsonrpc:'2.0',method:'notifications/initialized'});return post({jsonrpc:'2.0',id:2,method:c.method,...(c.params===undefined?{}:{params:c.params})})}
async function legacy(){const u=await safe(base),r=await fetch(u,{headers:{...c.headers,accept:'text/event-stream'},redirect:'error',signal:AbortSignal.timeout(c.timeoutMs)});if(!r.ok||!r.body)throw Error('Remote MCP SSE connection failed ('+r.status+')');const reader=r.body.getReader(),decoder=new TextDecoder(),queue=[],wait=[];let buffer='';function push(v){const f=wait.shift();f?f(v):queue.push(v)}void(async()=>{for(;;){const x=await reader.read();if(x.done){push({error:Error('Remote MCP SSE connection closed')});break}buffer+=decoder.decode(x.value,{stream:true});if(Buffer.byteLength(buffer)>120000){await reader.cancel();throw Error('Remote MCP response too large')}let i;while((i=buffer.search(/\r?\n\r?\n/))>=0){const b=buffer.slice(0,i),m=/\r?\n\r?\n/.exec(buffer.slice(i));buffer=buffer.slice(i+(m?.[0].length||2));let event='message',data='';for(const l of b.split(/\r?\n/)){if(l.startsWith('event:'))event=l.slice(6).trim();if(l.startsWith('data:'))data+=l.slice(5).trim()}push({event,data})}}})().catch(e=>push({error:e}));const next=()=>queue.length?Promise.resolve(queue.shift()):new Promise(ok=>wait.push(ok));let endpoint;while(!endpoint){const e=await next();if(e.error)throw e.error;if(e.event==='endpoint')endpoint=new URL(e.data,base)}await safe(endpoint,true);async function post(msg){const p=await fetch(endpoint,{method:'POST',headers,body:JSON.stringify(msg),redirect:'error',signal:AbortSignal.timeout(c.timeoutMs)});if(!p.ok)throw Error('Remote MCP SSE request failed ('+p.status+')');if(msg.id==null)return null;for(;;){const e=await next();if(e.error)throw e.error;if(e.event==='message'){const v=JSON.parse(e.data);if(v.id===msg.id){if(v.error)throw Error(String(v.error.message||'Remote MCP error'));return v.result}}}}const init=await post({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'toolplane-sandbox-inspector',version:'1.0.0'}}});await post({jsonrpc:'2.0',method:'notifications/initialized'});const out=await post({jsonrpc:'2.0',id:2,method:c.method,...(c.params===undefined?{}:{params:c.params})});await reader.cancel();return out}
try{const result=c.transport==='sse'?await legacy():await streamable();process.stdout.write(JSON.stringify({result}))}catch(e){const m=String(e?.message||e);process.stdout.write(JSON.stringify({error:/\((?:401|403)\)/.test(m)?'authentication_failed':'connection_failed'}))}
})()`;

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function firstText(value: Record<string, unknown> | null): string | null {
  const content = Array.isArray(value?.content) ? value.content : [];
  const first = object(content[0]);
  return typeof first?.text === 'string' ? first.text : null;
}

export async function mcpRpcViaSandbox(
  sandboxDeploymentId: string,
  remote: RemoteSpec,
  method: string,
  params?: Record<string, unknown>,
  privateHosts = '',
): Promise<Record<string, unknown> | null> {
  const stdin = `${JSON.stringify({
    url: remote.url,
    transport: remote.transport,
    headers: remote.headers,
    privateHosts,
    timeoutMs: Math.min(remote.timeoutMs, 120_000),
    method,
    ...(params === undefined ? {} : { params }),
  })}\n${CLIENT}`;
  const outer = await mcpRpc(
    sandboxDeploymentId,
    'tools/call',
    {
      name: 'process_exec',
      arguments: {
        runtime: 'node',
        args: ['-e', BOOTSTRAP],
        stdin,
        timeoutMs: Math.min(remote.timeoutMs, 120_000),
      },
    },
    Math.min(remote.timeoutMs, 120_000) + 5_000,
    { maxRequestBytes: 1_000_000, maxResponseBytes: 256_000 },
  );
  if (!outer || outer.isError === true) return null;
  const executionText = firstText(outer);
  if (!executionText) return null;
  let execution: Record<string, unknown> | null;
  try {
    execution = object(JSON.parse(executionText));
  } catch {
    return null;
  }
  if (!execution || execution.exitCode !== 0 || execution.timedOut === true || typeof execution.stdout !== 'string') {
    return null;
  }
  let response: Record<string, unknown> | null;
  try {
    response = object(JSON.parse(execution.stdout));
  } catch {
    return null;
  }
  if (response?.error === 'authentication_failed') throw new SandboxMcpAuthenticationError();
  return response && !response.error ? object(response.result) : null;
}

export async function listMcpToolsViaSandbox(
  sandboxDeploymentId: string,
  remote: RemoteSpec,
  privateHosts = '',
): Promise<McpToolDefinition[] | null> {
  const tools: McpToolDefinition[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await mcpRpcViaSandbox(
      sandboxDeploymentId,
      remote,
      'tools/list',
      cursor ? { cursor } : undefined,
      privateHosts,
    );
    const listed = parseMcpToolCatalogResult(result?.tools);
    if (!listed.ok || listed.tools.length > MAX_TOOLS - tools.length) return null;
    const combined = parseMcpToolCatalogResult([...tools, ...listed.tools]);
    if (!combined.ok) return null;
    tools.splice(0, tools.length, ...combined.tools);
    if (result?.nextCursor === undefined) return tools;
    const nextCursor = result.nextCursor;
    if (typeof nextCursor !== 'string' || !nextCursor || nextCursor.length > 4_000 || cursors.has(nextCursor)) {
      return null;
    }
    cursors.add(nextCursor);
    cursor = nextCursor;
  }
  return null;
}
