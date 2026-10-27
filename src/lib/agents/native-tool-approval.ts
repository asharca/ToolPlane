/** Native Pi SDK pre-execution hook; tool activity is never an authorization boundary. */
export function nativeApprovalAdapter(helperPath: string) {
  const imports = `import { approvalReady, approveNativeTool, freezeArguments } from ${JSON.stringify(helperPath)};\n`;
  return `${imports}
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
}
