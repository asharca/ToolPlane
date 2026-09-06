// ToolPlane owns the conversation transcript; DSH owns commands and durable goal state.
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export const name = 'toolplane-driver';
export const inject = ['agents', 'sessions', 'agentDefaultModel', 'commands', 'sessionPersistence'];

export function apply(ctx) {
  const exit = ctx.get('appExit');
  void run(ctx).then(() => exit(0), (error) => { process.stderr.write(`ToolPlane DSH: ${error.message}\n`); exit(1); });
}

async function run(ctx) {
  await ctx.get('loader')?.await();
  const input = JSON.parse(await readFile(process.env.TOOLPLANE_DSH_INPUT, 'utf8'));
  const require = createRequire(`${input.packageRoot}/node_modules/.pnpm/toolplane-resolver.cjs`);
  const { installModelSelection } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-agent')).href);
  const { createUserMessage } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')).href);
  const emit = (value) => process.stdout.write(input.prefix + JSON.stringify(value) + '\n');
  const commands = ctx.get('commands');
  const selection = ctx.get('agentDefaultModel').currentSelection();
  const options = {
    agentOptions: { provider: selection.provider, model: selection.model },
    setup: (agentCtx) => { installModelSelection(agentCtx, { current: selection, assembled: undefined }); },
  };
  // ponytail: listing is scoped to this Agent's DSH_HOME; use an indexed lookup if session counts grow.
  const exists = (await ctx.get('sessionPersistence').list()).some((session) => session.id === input.sessionId);
  const { agent } = exists
    ? await ctx.get('agents').resume({ ...options, resumeSessionId: input.sessionId })
    : await ctx.get('agents').create({ ...options, sessionId: input.sessionId, meta: { cwd: process.cwd() } });
  await agent.whenIdle();
  emit({ type: 'commands', commands: commands.list(agent).map(({ name, description }) => ({ name, description })) });
  // Import pre-native history once. Replaying it on resume would undo native compaction.
  if (!exists && input.history) agent.session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: input.history }], source: { kind: 'user' },
  }), { surfaceOp: 'append' });
  const firstSeq = agent.session.seq;
  let result;
  try {
    if (input.command) {
      const execution = await commands.execute(agent, input.command, [], new AbortController().signal);
      if (!execution) throw new Error('This DSH command is not registered.');
      result = execution.result;
    } else {
      agent.followup(createUserMessage({ content: [{ type: 'text', text: input.message }], source: { kind: 'user' } }));
    }
    await agent.whenIdle();
    const endings = agent.session.events.filter((event) => event.seq >= firstSeq && event.type === 'turn/end');
    const failure = endings.find((event) => ['error', 'aborted'].includes(event.data.reason.kind));
    if (failure) throw new Error(failure.data.reason.error?.message || 'DSH turn was aborted.');
    if (!input.command && endings.at(-1)?.data.reason.kind !== 'completed') throw new Error('DSH turn did not complete.');
    if (result) emit({ type: 'command', text: result.text || 'Command completed.', isError: result.kind === 'error' });
  } finally {
    await ctx.get('sessions').flush(agent.session);
  }
}
