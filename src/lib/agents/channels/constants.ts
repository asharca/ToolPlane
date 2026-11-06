// Adapted from Cherry Studio. See NOTICE for source and license.
export const SLASH_COMMANDS = [
  { name: "new", description: "Start a new conversation" },
  { name: "compact", description: "Compact conversation history" },
  { name: "help", description: "Show available commands" },
  { name: "whoami", description: "Show chat info" },
  { name: "status", description: "Show session status" },
  { name: "resume", description: "Resume a previous conversation" },
  { name: "model", description: "Set the session model (admin)" },
  { name: "upgrade", description: "Upgrade the session revision (admin)" },
] as const;

const COMMAND_REGEX = new RegExp(
  `^\\/(${SLASH_COMMANDS.map((c) => c.name).join("|")})\\b`,
);

export function isSlashCommand(text: string): boolean {
  return COMMAND_REGEX.test(text);
}
