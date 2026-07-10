export const SITE = {
  name: 'ToolPlane',
  compactName: 'ToolPlane',
  supportEmail: 'support@toolplane.local',
  feedbackEmail: 'feedback@toolplane.local',
  protocolUrl: 'https://modelcontextprotocol.io',
  claudeCodeUrl: 'https://claude.com/claude-code',
  sourceUrl: 'https://github.com/asharca/ToolPlane',
} as const;

export function mailto(email: string): string {
  return `mailto:${email}`;
}
