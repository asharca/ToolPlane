/** Pinned runtime hooks; these run BEFORE execution, never from tool activity logs. */
export function nativeApprovalAdapter(runtime: 'pi' | 'dsh', helperPath: string) {
  const imports = `import { approvalReady, approveNativeTool, freezeArguments } from ${JSON.stringify(helperPath)};\n`;
  if (runtime === 'pi') return `${imports}
export default async function (pi) {
  pi.on('tool_call', async (event) => {
    try {
      freezeArguments(event.input);
      const allowed = await approveNativeTool(event.toolName, event.input, event.toolCallId);
      if (!allowed) return { block: true, reason: 'This tool call was not approved in ToolPlane.' };
    } catch { return { block: true, reason: 'ToolPlane approval verification failed.' }; }
  });
  await approvalReady();
}
`;
  return `${imports}
export const name = 'toolplane-native-approval';
export async function apply(ctx) {
  ctx.on('tools/pre-execute', async (execution, next) => {
    try {
      freezeArguments(execution.arguments);
      if (!await approveNativeTool(execution.name, execution.arguments, execution.callId, execution.signal)) {
        return { kind: 'deny', reason: 'This tool call was not approved in ToolPlane.' };
      }
      return await next(); // Preserve additional upstream denials; never replace them with allow.
    } catch { return { kind: 'deny', reason: 'ToolPlane approval verification failed.' }; }
  });
  await approvalReady();
}
`;
}
export function claudeApprovalSettings(helperPath: string) {
  // Path is platform-generated, not a model/tool argument. Explicit shell fallback denies even
  // if node cannot load the script; dontAsk remains the fallback if Claude cancels a timed-out hook.
  if (!/^\/[a-zA-Z0-9_./-]+\.mjs$/.test(helperPath)) throw new Error('Invalid approval helper path.');
  return JSON.stringify({ disableAllHooks: false, permissions: { defaultMode: 'dontAsk', allow: [] }, hooks: {
    SessionStart: [{ hooks: [{ type: 'command', command: `node '${helperPath}' --ready || exit 2`, timeout: 20 }] }],
    PreToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: `node '${helperPath}' --claude || exit 2`, timeout: 600 }] }],
  } });
}
