import { z } from 'zod';
import { piPackageMcpRequirementsSchema } from '@/lib/market/pi-package-manifest';

export type PiPackageMcpToolPolicy = Record<string, string[]>;

const bindingsSchema = z.record(z.string(), z.object({
  deploymentId: z.string().min(1).max(200),
  tools: z.array(z.string().min(1).max(256)).max(256),
}).strict());

/** Only explicitly requested and explicitly bound MCP tools become Agent capabilities. */
export function resolvePiPackageMcpPolicy(requirements: unknown, resourceMap: unknown): PiPackageMcpToolPolicy {
  if (requirements === undefined || requirements === null) return {};
  const parsed = piPackageMcpRequirementsSchema.safeParse(requirements);
  if (!parsed.success) throw new Error('PI_PACKAGE_UNAVAILABLE');
  if (!parsed.data.length) return {};
  const map = resourceMap && typeof resourceMap === 'object' && !Array.isArray(resourceMap)
    ? resourceMap as Record<string, unknown> : {};
  const bindings = bindingsSchema.safeParse(map.mcpBindings);
  if (!bindings.success) throw new Error('PI_PACKAGE_MCP_BINDING_REQUIRED');
  const result: PiPackageMcpToolPolicy = {};
  const seen = new Set<string>();
  for (const requirement of parsed.data) {
    if (seen.has(requirement.key)) throw new Error('PI_PACKAGE_UNAVAILABLE');
    seen.add(requirement.key);
    const binding = bindings.data[requirement.key];
    if (!binding || requirement.tools.some((tool) => !binding.tools.includes(tool))) {
      throw new Error('PI_PACKAGE_MCP_BINDING_REQUIRED');
    }
    const tools = result[binding.deploymentId] ??= [];
    for (const tool of requirement.tools) if (!tools.includes(tool)) tools.push(tool);
  }
  for (const tools of Object.values(result)) tools.sort();
  return result;
}
