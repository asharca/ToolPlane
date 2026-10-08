import 'server-only';
import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { buildSkillReleaseManifest } from '@/lib/market/skill-manifest';
import type { PiPackageEntryV1, PiPackageSnapshotV1 } from '@/lib/market/pi-package-manifest';
import { readMcpToolCatalog } from '@/lib/process/mcp-tool-catalog';
import { piPackageMcpAdapterSource } from '@/lib/pi-packages/adapter';
import { MarketError } from '@/lib/market/skills';

export type PiPackageMcpBindings = Record<string, { deploymentId: string; tools: string[] }>;
export type PiPackageAssemblyInput = {
  workspaceId: string;
  name: string;
  version: string;
  installedSkillIds: string[];
  mcps: Array<{ deploymentId: string; tools: string[] }>;
};

/** Read selected resources inside the publisher transaction; never serialize their identities. */
export async function assemblePiPackage(tx: Prisma.TransactionClient, input: PiPackageAssemblyInput): Promise<{ snapshot: PiPackageSnapshotV1; bindings: PiPackageMcpBindings }> {
  if (!/^(?:@[a-z0-9-][a-z0-9._-]*\/)?[a-z0-9-][a-z0-9._-]*$/.test(input.name) || input.name.length > 214 || ['node_modules', 'favicon.ico'].includes(input.name)
    || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(input.version)
    || input.installedSkillIds.length > 64 || input.mcps.length > 64
    || new Set(input.installedSkillIds).size !== input.installedSkillIds.length
    || new Set(input.mcps.map((item) => item.deploymentId)).size !== input.mcps.length
    || !input.installedSkillIds.length && !input.mcps.length) throw new MarketError('pi_package_invalid_selection', 'Select valid package resources and an exact npm name/version.');
  const skills = await tx.installedSkill.findMany({
    where: { id: { in: input.installedSkillIds }, workspaceId: input.workspaceId }, include: { skill: true }, orderBy: { id: 'asc' },
  });
  if (skills.length !== input.installedSkillIds.length) throw new MarketError('pi_package_source_unavailable', 'A selected Skill is unavailable.');
  const deployments = await tx.deployment.findMany({
    where: { id: { in: input.mcps.map((item) => item.deploymentId) }, workspaceId: input.workspaceId },
    include: { server: true }, orderBy: { id: 'asc' },
  });
  if (deployments.length !== input.mcps.length) throw new MarketError('pi_package_source_unavailable', 'A selected MCP is unavailable.');
  const entries: PiPackageEntryV1[] = [];
  function file(path: string, bytes: Buffer) {
    entries.push({ type: 'file', path, contentEncoding: 'base64', content: bytes.toString('base64'), executable: false, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  const resources: PiPackageSnapshotV1['resources'] = { extensions: [], skills: [], prompts: [], themes: [] };
  for (const source of skills) {
    const skill = buildSkillReleaseManifest(source).skill;
    const key = `${skill.slug.replace(/[^a-z0-9-]/g, '-').slice(0, 60) || 'skill'}-${createHash('sha256').update(source.id).digest('hex').slice(0, 12)}`;
    const root = `package/skills/${key}`;
    file(`${root}/SKILL.md`, Buffer.from(skill.content));
    for (const extra of skill.files) file(`${root}/${extra.path}`, Buffer.from(extra.content, extra.encoding === 'base64' ? 'base64' : 'utf8'));
    resources.skills.push(`${root}/SKILL.md`);
  }
  const bindings: PiPackageMcpBindings = {};
  const mcp: NonNullable<PiPackageSnapshotV1['toolplane']>['mcp'] = [];
  for (const deployment of deployments) {
    const tools = [...input.mcps.find((item) => item.deploymentId === deployment.id)!.tools].sort();
    const catalog = readMcpToolCatalog(deployment.installCfg);
    const names = new Set(catalog.map((tool) => tool.name));
    if (!tools.length || tools.length > 256 || new Set(tools).size !== tools.length
      || tools.some((name) => !names.has(name) || deployment.mcpToolExposure === 'allowlist' && !deployment.mcpAllowedTools.includes(name))) throw new MarketError('pi_package_tools_unavailable', 'Selected MCP tools are unavailable.');
    const key = `mcp-${createHash('sha256').update(deployment.id).digest('hex').slice(0, 16)}`;
    mcp.push({ key, name: deployment.name || deployment.server?.name || key, tools });
    bindings[key] = { deploymentId: deployment.id, tools };
  }
  if (mcp.length) {
    resources.extensions.push('package/extensions/toolplane-mcp.mjs');
    file('package/extensions/toolplane-mcp.mjs', Buffer.from(piPackageMcpAdapterSource()));
  }
  const pi = {
    extensions: resources.extensions.map((path) => path.slice('package/'.length)),
    skills: resources.skills.map((path) => path.slice('package/'.length)),
    prompts: [], themes: [],
  };
  file('package/package.json', Buffer.from(`${JSON.stringify({ name: input.name, version: input.version, type: 'module', keywords: ['pi-package'], pi, toolplane: { schemaVersion: 1, mcp } }, null, 2)}\n`));
  return { bindings, snapshot: {
    source: { kind: 'toolplane', requested: `toolplane:${input.name}@${input.version}`, name: input.name, version: input.version },
    name: input.name, version: input.version,
    runtime: { kind: 'pi-sdk', piVersion: '0.87.1', nodeMajor: 24, platform: 'any', arch: 'any' },
    root: 'package', resources, entries: entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0), toolplane: { schemaVersion: 1, mcp },
  } };
}

export async function validatePiPackageMcpBindings(tx: Prisma.TransactionClient, workspaceId: string, manifest: PiPackageSnapshotV1, bindings: PiPackageMcpBindings): Promise<void> {
  const requirements = manifest.toolplane?.mcp ?? [];
  if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings) || Object.keys(bindings).some((key) => !requirements.some((item) => item.key === key))) throw new MarketError('pi_package_invalid_bindings', 'Invalid package MCP bindings.');
  for (const [key, binding] of Object.entries(bindings)) {
    const requirement = requirements.find((item) => item.key === key)!;
    if (!binding || typeof binding.deploymentId !== 'string' || !Array.isArray(binding.tools)
      || new Set(binding.tools).size !== binding.tools.length || binding.tools.length !== requirement.tools.length
      || binding.tools.some((name) => !requirement.tools.includes(name))) throw new MarketError('pi_package_invalid_bindings', 'Invalid package MCP bindings.');
    const deployment = await tx.deployment.findFirst({ where: { id: binding.deploymentId, workspaceId }, select: { installCfg: true, mcpToolExposure: true, mcpAllowedTools: true } });
    const available = new Set(deployment ? readMcpToolCatalog(deployment.installCfg).map((tool) => tool.name) : []);
    if (!deployment || binding.tools.some((name) => !available.has(name) || deployment.mcpToolExposure === 'allowlist' && !deployment.mcpAllowedTools.includes(name))) throw new MarketError('pi_package_tools_unavailable', 'Selected MCP tools are unavailable.');
  }
}
