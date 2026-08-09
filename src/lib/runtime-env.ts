// NEXT_PUBLIC_* variables are normally replaced while Next.js builds the
// bundle. Looking them up through a dynamic key keeps server-only consumers
// configurable when the standalone Docker image starts.
export function runtimeEnv(name: string): string | undefined {
  return process.env[name];
}
