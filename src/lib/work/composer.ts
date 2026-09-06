import 'server-only';
import type { Prisma } from '@prisma/client';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { getAgentForRequest, ORDINARY_AGENT_FILTER } from '@/lib/agents/queries';
import { resolveAgentTools } from '@/lib/agents/resolve';
import { activeConversationMessages, compactionTranscript } from '@/lib/agents/conversation-context';
import { displayMessagingUserText } from '@/lib/agents/messaging';
import { skillLabel } from '@/lib/workspace/skill-label';
import { buildInstalledSkillMarkdown } from '@/lib/skills/artifact';
import { mcpRpc } from '@/lib/process/mcp-client';
import { listAttachedMcpResources, readAttachedMcpResource } from '@/lib/process/mcp-resources';
import { normalizeWorkDirectory } from './sessions';
import type { ComposerItem, ComposerReference } from './composer-types';

type Agent = NonNullable<Awaited<ReturnType<typeof getAgentForRequest>>>;
export class ComposerRequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

// ponytail: bounded on-demand filesystem scan; use a sandbox index if large trees need exhaustive search.
const FILES_SCRIPT = String.raw`(async()=>{
const fs=require('node:fs/promises'),p=require('node:path'),input=JSON.parse(process.argv[1]),root=await fs.realpath(process.cwd());
if(input.read){
  const file=await fs.realpath(p.resolve(root,input.read));
  if(!file.startsWith(root+p.sep))throw Error('Invalid path');
  const handle=await fs.open(file,'r');
  try{if(!(await handle.stat()).isFile())throw Error('Not a file');const buffer=Buffer.alloc(64001);const {bytesRead}=await handle.read(buffer,0,buffer.length,0);const data=buffer.subarray(0,bytesRead);if(data.includes(0))throw Error('Binary file');const text=data.toString('utf8');process.stdout.write(JSON.stringify({text:text.slice(0,16000)+(text.length>16000||bytesRead===64001?'\n[Truncated]':'')}));}finally{await handle.close();}
  return;
}
const q=input.query.toLowerCase(),items=[],queue=[{dir:root,depth:0}],ignored=new Set(['.git','node_modules','.next']);let visited=0;
while(queue.length&&items.length<40&&visited<5000){const {dir,depth}=queue.shift();let entries;try{entries=await fs.readdir(dir,{withFileTypes:true});}catch{continue;}
  entries.sort((a,b)=>a.name.localeCompare(b.name));
  for(const entry of entries){if(++visited>5000||items.length>=40)break;if(entry.isSymbolicLink()||ignored.has(entry.name))continue;const full=p.join(dir,entry.name),relative=p.relative(root,full).split(p.sep).join('/');
    if(!q||relative.toLowerCase().includes(q))items.push({kind:entry.isDirectory()?'folder':'file',id:relative,label:relative});
    if(q&&entry.isDirectory()&&depth<10)queue.push({dir:full,depth:depth+1});
  }
}process.stdout.write(JSON.stringify({items}));
})().catch(()=>{process.stderr.write('Sandbox file is unavailable');process.exitCode=1;})`;

async function sandboxForComposer(agent: Agent, sandboxId?: string, workSessionId?: string) {
  if (workSessionId) {
    const work = await db.workSession.findFirst({ where: { id: workSessionId, workspaceId: agent.workspaceId, agentId: agent.id }, select: { sandboxId: true } });
    if (!work?.sandboxId || (sandboxId && sandboxId !== work.sandboxId)) throw new ComposerRequestError(404, 'Work sandbox not found.');
    sandboxId = work.sandboxId;
  }
  if (!sandboxId || (!agent.sandboxes.some((link) => link.sandboxId === sandboxId) && agent.runtime?.sandboxId !== sandboxId)) {
    throw new ComposerRequestError(404, 'Sandbox is not attached to this Agent.');
  }
  const sandbox = await db.sandbox.findFirst({ where: { id: sandboxId, workspaceId: agent.workspaceId }, select: { id: true, deploymentId: true, kind: true } });
  if (!sandbox) throw new ComposerRequestError(404, 'Sandbox not found.');
  return sandbox;
}

async function sandboxFiles(deploymentId: string, input: { query?: string; read?: string }, signal?: AbortSignal) {
  const result = await mcpRpc(deploymentId, 'tools/call', {
    name: 'process_exec', arguments: { runtime: 'node', args: ['-e', FILES_SCRIPT, JSON.stringify(input)], cwd: '.', timeoutMs: 10_000 },
  }, 15_000, { signal, maxResponseBytes: 256 * 1024 });
  const parsed = CallToolResultSchema.safeParse(result);
  const first = parsed.success ? parsed.data.content.find((part) => part.type === 'text')?.text : undefined;
  if (!parsed.success || parsed.data.isError || typeof first !== 'string') throw new ComposerRequestError(502, 'Sandbox files are unavailable.');
  const execution = JSON.parse(first) as { exitCode?: number; stdout?: string };
  if (execution.exitCode !== 0 || !execution.stdout) throw new ComposerRequestError(422, 'The sandbox file cannot be read as text.');
  return JSON.parse(execution.stdout) as { items?: ComposerItem[]; text?: string };
}

async function sessionScope(agent: Agent, sandboxId: string): Promise<Prisma.ConversationWhereInput> {
  const channels = await db.agentChannelConnection.findMany({ where: { workspaceId: agent.workspaceId, sandboxId }, select: { id: true, agentId: true } });
  return {
    agent: { workspaceId: agent.workspaceId, ...ORDINARY_AGENT_FILTER },
    publicApiConversation: { is: null },
    OR: [
      { workSession: { is: { workspaceId: agent.workspaceId, sandboxId, status: { not: 'archived' } } } },
      ...channels.filter((channel) => channel.agentId).map((channel) => ({ agentId: channel.agentId!, runtimeSessionKey: { startsWith: `channel:${channel.id}:` } })),
    ],
  };
}

function attachedSkills(agent: Agent) {
  const skills = [...agent.skills, ...agent.toolkits.flatMap((link) => link.toolkit.skills)].map((link) => link.installedSkill);
  return [...new Map(skills.map((skill) => [skill.id, skill])).values()].filter((skill) => skill.userInvocable && skill.status === 'published');
}

export async function listComposerItems(agent: Agent, input: {
  section: 'references' | 'resources' | 'skills'; query: string; sandboxId?: string; workSessionId?: string; excludeConversationId?: string;
}, signal?: AbortSignal): Promise<{ items: ComposerItem[]; filesUnavailable?: boolean }> {
  if (input.section === 'skills') {
    return { items: attachedSkills(agent).map((skill) => ({ kind: 'skill' as const, id: skill.id, label: skillLabel(skill).name, description: skill.description ?? skill.skill?.description ?? '' })) };
  }
  if (input.section === 'resources') {
    const resources = await listAttachedMcpResources({ workspaceId: agent.workspaceId, deploymentIds: resolveAgentTools(agent).deploymentIds, signal });
    return { items: resources.map((resource) => ({ kind: 'resource', id: resource.uri, deploymentId: resource.deploymentId, label: resource.name, description: resource.serverName })) };
  }
  const sandbox = await sandboxForComposer(agent, input.sandboxId, input.workSessionId);
  const [files, sessions] = await Promise.all([
    sandboxFiles(sandbox.deploymentId, { query: input.query }, signal).catch(() => null),
    db.conversation.findMany({ where: {
      ...await sessionScope(agent, sandbox.id),
      ...(input.excludeConversationId ? { id: { not: input.excludeConversationId } } : {}),
      ...(input.query ? { title: { contains: input.query, mode: 'insensitive' } } : {}),
    }, select: { id: true, title: true, agent: { select: { name: true } } }, orderBy: { createdAt: 'desc' }, take: 40 }),
  ]);
  const fileItems = Array.isArray(files?.items) ? files.items : [];
  return { items: [
    ...fileItems.slice(0, input.query ? 40 : 5),
    ...sessions.map((session) => ({ kind: 'session' as const, id: session.id, label: session.title ?? session.id, description: session.agent.name })),
  ], ...(!files ? { filesUnavailable: true } : {}) };
}

export async function resolveComposerReference(agent: Agent, input: {
  kind: ComposerReference['kind']; id: string; deploymentId?: string; sandboxId?: string; workSessionId?: string;
}, signal?: AbortSignal): Promise<ComposerReference> {
  let label: string;
  let text: string;
  if (input.kind === 'skill') {
    const skill = attachedSkills(agent).find((skill) => skill.id === input.id);
    if (!skill) throw new ComposerRequestError(404, 'Skill is not available to this Agent.');
    label = skillLabel(skill).name;
    text = buildInstalledSkillMarkdown(skill);
  } else if (input.kind === 'resource') {
    if (!input.deploymentId) throw new ComposerRequestError(400, 'MCP deployment is required.');
    const result = await readAttachedMcpResource({ workspaceId: agent.workspaceId, deploymentIds: resolveAgentTools(agent).deploymentIds, deploymentId: input.deploymentId, uri: input.id, signal });
    label = result.resource.name;
    text = `${input.id}\n${result.text}`;
  } else {
    const sandbox = await sandboxForComposer(agent, input.sandboxId, input.workSessionId);
    if (input.kind === 'file') {
      const path = normalizeWorkDirectory(input.id);
      if (!path || path === '.') throw new ComposerRequestError(400, 'Invalid file path.');
      const result = await sandboxFiles(sandbox.deploymentId, { read: path }, signal);
      if (typeof result.text !== 'string') throw new ComposerRequestError(422, 'No readable file content.');
      label = path;
      text = `${sandbox.kind === 'hermes' ? '/opt/data/workspace' : '/workspace'}/${path}\n${result.text}`;
    } else {
      const session = await db.conversation.findFirst({ where: { ...await sessionScope(agent, sandbox.id), id: input.id },
        include: { messages: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 100 } } });
      if (!session) throw new ComposerRequestError(404, 'Conversation is not in the current sandbox.');
      label = session.title ?? session.id;
      text = compactionTranscript(activeConversationMessages(session.messages.reverse()).map((message) => ({ ...message, parts: Array.isArray(message.parts) ? message.parts.map((part) => {
        if (message.role !== 'user' || !part || typeof part !== 'object' || !('text' in part) || typeof part.text !== 'string') return part;
        return { ...part, text: displayMessagingUserText(part.text) };
      }) : [] })));
      if (!text.trim()) throw new ComposerRequestError(422, 'The referenced conversation is empty.');
    }
  }
  label = label.slice(0, 1000);
  const body = text.length > 17_000 ? `${text.slice(0, 17_000)}\n[Truncated]` : text;
  return { kind: input.kind, id: input.id, ...(input.kind === 'resource' ? { deploymentId: input.deploymentId } : {}), label, text: `Reference material (${input.kind}): ${label}\n${body}` };
}
