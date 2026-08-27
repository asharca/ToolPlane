export const AGENT_RUNTIME_KINDS = ['pi', 'claude-code', 'dsh', 'hermes'] as const;

export type AgentRuntimeKind = (typeof AGENT_RUNTIME_KINDS)[number];
export type ImplementedAgentRuntimeKind = AgentRuntimeKind;
export type SandboxHarnessRuntimeKind = Extract<AgentRuntimeKind, 'claude-code' | 'dsh'>;
export type DedicatedSandboxRuntimeKind = Extract<AgentRuntimeKind, 'pi' | 'claude-code' | 'dsh'>;
export type WorkRuntimeKind = DedicatedSandboxRuntimeKind | 'hermes';

export type AgentRuntimeBuiltinToolCategory =
  | 'file'
  | 'shell'
  | 'search'
  | 'context'
  | 'orchestration'
  | 'browser'
  | 'media';

export type AgentRuntimeBuiltinToolGroup = {
  category: AgentRuntimeBuiltinToolCategory;
  tools: readonly string[];
};

const AGENT_RUNTIME_BUILTIN_TOOL_GROUPS: Record<AgentRuntimeKind, readonly AgentRuntimeBuiltinToolGroup[]> = {
  pi: [
    { category: 'file', tools: ['read', 'edit', 'write'] },
    { category: 'shell', tools: ['bash'] },
  ],
  'claude-code': [
    { category: 'file', tools: ['Read', 'Edit', 'Write'] },
    { category: 'search', tools: ['Glob', 'Grep'] },
    { category: 'shell', tools: ['Bash'] },
    { category: 'orchestration', tools: ['Workflow'] },
  ],
  dsh: [
    { category: 'file', tools: ['read', 'read_image', 'edit', 'write', 'str_replace_editor'] },
    { category: 'search', tools: ['glob', 'grep', 'web_search'] },
    { category: 'shell', tools: ['bash', 'job_output', 'job_list', 'job_kill'] },
    {
      category: 'orchestration',
      tools: [
        'todo_write',
        'skill',
        'get_goal',
        'create_goal',
        'update_goal',
        'exit_plan_mode',
        'subagent',
        'subagent_fork',
        'send_message',
        'interrupt_agent',
        'list_agents',
        'workflow',
        'ralph',
      ],
    },
  ],
  hermes: [
    { category: 'file', tools: ['read_file', 'write_file', 'patch', 'search_files'] },
    { category: 'shell', tools: ['terminal', 'process'] },
    { category: 'context', tools: ['web_search', 'web_extract', 'memory', 'session_search'] },
    {
      category: 'browser',
      tools: [
        'browser_navigate',
        'browser_snapshot',
        'browser_click',
        'browser_type',
        'browser_scroll',
        'browser_back',
        'browser_press',
        'browser_get_images',
        'browser_vision',
        'browser_console',
        'browser_cdp',
        'browser_dialog',
        'browser_exec',
      ],
    },
    {
      category: 'orchestration',
      tools: [
        'skills_list',
        'skill_view',
        'skill_manage',
        'todo',
        'execute_code',
        'delegate_task',
        'cronjob',
      ],
    },
    {
      category: 'media',
      tools: [
        'vision_analyze',
        'image_generate',
        'bfl_flux3_text_to_video',
        'bfl_flux3_image_to_video',
        'bfl_flux3_keyframes_to_video',
        'bfl_flux3_video_continuation',
        'bfl_flux3_get_result',
        'bfl_flux3_prompting_guide',
      ],
    },
  ],
};

const GENERIC_PROXY_PROVIDER_FORMATS = new Set(['openai', 'openai-responses', 'anthropic']);

export function agentRuntimeDisplayName(value: string): string {
  if (value === 'claude-code') return 'Claude Code';
  if (value === 'dsh') return 'DeepSeek Harness';
  if (value === 'hermes') return 'Hermes';
  if (value === 'pi') return 'Pi';
  return value;
}

export function implementedAgentRuntimeKind(value: unknown): ImplementedAgentRuntimeKind | null {
  return value === 'pi' || value === 'claude-code' || value === 'dsh' || value === 'hermes'
    ? value
    : null;
}

export function agentRuntimeBuiltinToolGroups(value: unknown): readonly AgentRuntimeBuiltinToolGroup[] {
  const kind = implementedAgentRuntimeKind(value);
  return kind ? AGENT_RUNTIME_BUILTIN_TOOL_GROUPS[kind] : [];
}

export function isSandboxHarnessRuntimeKind(value: unknown): value is SandboxHarnessRuntimeKind {
  return value === 'claude-code' || value === 'dsh';
}

export function isDedicatedSandboxRuntimeKind(value: unknown): value is DedicatedSandboxRuntimeKind {
  return value === 'pi' || isSandboxHarnessRuntimeKind(value);
}

export function isWorkRuntimeKind(value: unknown): value is WorkRuntimeKind {
  return value === 'hermes' || isDedicatedSandboxRuntimeKind(value);
}

export function agentRuntimeSupportsProviderFormat(runtime: string, format: string): boolean {
  if (isDedicatedSandboxRuntimeKind(runtime)) return GENERIC_PROXY_PROVIDER_FORMATS.has(format);
  return true;
}
