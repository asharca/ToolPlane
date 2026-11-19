import "server-only";

export function dockerCliEnv(): NodeJS.ProcessEnv {
  const env = {} as NodeJS.ProcessEnv;
  for (const key of [
    "PATH",
    "HOME",
    "DOCKER_HOST",
    "DOCKER_CERT_PATH",
    "DOCKER_TLS_VERIFY",
    "LANG",
    "LC_ALL",
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}
