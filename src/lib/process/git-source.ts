const NPM_OPTIONS_WITH_VALUE = new Set([
  '-c',
  '-p',
  '--cache',
  '--call',
  '--node-options',
  '--npm',
  '--package',
  '--registry',
  '--userconfig',
]);

// npm's hosted-git-info shorthands. `owner/repo` remains GitHub-only; other
// forges should use an explicit hosted shortcut or a Git URL.
const HOSTED_GIT_SHORTCUT = /^(?:github|gitlab|bitbucket|gist):[^\s]+$/i;
const GITHUB_SHORTCUT = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:#[^\s]+)?$/;

// Explicit Git transports work for any forge reachable from the container. Do not
// classify arbitrary https URLs as Git: an HTTP tarball or an MCP endpoint
// does not need the larger wrapper image. A plain HTTPS URL is only a Git
// source when its path ends in `.git`; users can use `git+https://` to
// disambiguate repositories whose clone URL omits that suffix. `git://` and
// uv's `git+git://` are recognized for compatibility, though `git+https://`
// remains the safer transport for public repositories.
const EXPLICIT_GIT_URL = /^(?:git\+(?:https?|ssh|git)|git|ssh):\/\/[^\s]+$/i;
const HTTPS_GIT_URL = /^https?:\/\/[^\s?#]+\.git(?:[?#][^\s]*)?$/i;

// SCP-style Git remotes are valid for arbitrary hosts/users, not only the
// common `git@host:path` spelling. Require an `@` so URL-like non-Git npm
// specifiers such as `file:package` are not misclassified.
const SCP_GIT_URL = /^[^@\s/:]+@[^:\s/]+:[^\s]+$/;

function isGitSource(value: string): boolean {
  return HOSTED_GIT_SHORTCUT.test(value)
    || GITHUB_SHORTCUT.test(value)
    || EXPLICIT_GIT_URL.test(value)
    || HTTPS_GIT_URL.test(value)
    || SCP_GIT_URL.test(value);
}

function npxArgsNeedGit(args: readonly string[]): boolean {
  let optionsEnded = false;
  let skipNext = false;
  let packageOptionNext = false;

  for (const arg of args) {
    if (packageOptionNext) {
      packageOptionNext = false;
      if (isGitSource(arg)) return true;
      continue;
    }
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (!optionsEnded && arg === '--') {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && arg.startsWith('-')) {
      const [flag, assigned] = arg.split('=', 2);
      if ((flag === '-p' || flag === '--package') && assigned && isGitSource(assigned)) return true;
      if ((flag === '-p' || flag === '--package') && assigned === undefined) {
        packageOptionNext = true;
        continue;
      }
      skipNext = assigned === undefined && NPM_OPTIONS_WITH_VALUE.has(flag);
      continue;
    }
    return isGitSource(arg) || GITHUB_SHORTCUT.test(arg);
  }

  return false;
}

/**
 * Git package references need an image with the Git executable installed.
 * Regular npm/PyPI executions keep the slimmer wrapper images.
 */
export function commandArgsNeedGit(command: string, args: readonly string[]): boolean {
  if (command === 'npx') return npxArgsNeedGit(args);
  return (command === 'uvx' || command === 'uv') && args.some(isGitSource);
}
