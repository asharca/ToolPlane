const DOCKER_IMAGE = /^[a-z0-9]+([._/-][a-z0-9]+)*(:[\w.-]+)?$/;

const ALLOWED_DOCKER_RUN_OPTIONS = new Set([
  '-i',
  '--interactive',
  '--rm',
]);

export type DockerJsonCommand = {
  image: string;
  commandArgs: string[];
};

export function isValidDockerImageRef(value: string): boolean {
  return DOCKER_IMAGE.test(value);
}

/**
 * Accept the common MCP client form (`docker run -i --rm image ...`) without
 * letting JSON configuration control Docker's host-level run options.
 */
export function parseDockerJsonArgs(args: readonly string[]): DockerJsonCommand {
  let imageIndex = 0;

  if (args[0] === 'run') {
    imageIndex = 1;
    while (imageIndex < args.length) {
      const value = args[imageIndex];
      if (ALLOWED_DOCKER_RUN_OPTIONS.has(value)) {
        imageIndex += 1;
        continue;
      }
      if (value === '--') {
        imageIndex += 1;
        break;
      }
      if (value.startsWith('-')) {
        throw new Error(`unsupported docker run option: ${value}.`);
      }
      break;
    }
  }

  const image = args[imageIndex];
  if (!image || !isValidDockerImageRef(image)) {
    throw new Error('docker args must include a valid container image.');
  }

  return { image, commandArgs: args.slice(imageIndex + 1) };
}
