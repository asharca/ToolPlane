const BENIGN_STDERR_PATTERNS = [
  /^\[[^\]]+\] Connecting to .+ \(attempt \d+\/\d+\)/,
  /^\[[^\]]+\] Discovering .+ fallback IPs/,
  /^\[[^\]]+\] Connected to .+/,
  /^Failed to load plugin .+: No module named .+$/,
];

export function runnerStderrToLastError(chunk: string) {
  const message = chunk.trim().slice(0, 2000);
  if (!message) return null;
  if (BENIGN_STDERR_PATTERNS.some((pattern) => pattern.test(message))) return null;
  return message;
}

export function runnerStdoutIndicatesConnected(chunk: string) {
  return chunk.includes('[agent-channel-runner] connected ');
}
