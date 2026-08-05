'use strict';

/* eslint-disable @typescript-eslint/no-require-imports -- this launcher must preload and patch CommonJS Node/Next modules before Next starts. */

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

function findAppRoot(start) {
  let candidate = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(candidate, '.next', 'required-server-files.json'))) {
      return candidate;
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  throw new Error('Could not find .next/required-server-files.json; run `pnpm build` first.');
}

const appRoot = findAppRoot(__dirname);
process.env.NODE_ENV = 'production';
process.chdir(appRoot);

const requiredFiles = JSON.parse(fs.readFileSync(
  path.join(appRoot, '.next', 'required-server-files.json'),
  'utf8',
));
const nextConfig = requiredFiles.config;
process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(nextConfig);

require('next');
const { startServer } = require('next/dist/server/lib/start-server');
const port = Number.parseInt(process.env.PORT || '', 10) || 3000;
const hostname = process.env.HOSTNAME || '0.0.0.0';
const parsedKeepAliveTimeout = Number.parseInt(process.env.KEEP_ALIVE_TIMEOUT || '', 10);
const keepAliveTimeout = Number.isFinite(parsedKeepAliveTimeout) && parsedKeepAliveTimeout >= 0
  ? parsedKeepAliveTimeout
  : undefined;
const parsedRequestTimeout = Number.parseInt(process.env.TOOLPLANE_HTTP_REQUEST_TIMEOUT_MS || '', 10);
const requestTimeout = Number.isFinite(parsedRequestTimeout) && parsedRequestTimeout >= 60_000
  ? parsedRequestTimeout
  : 4 * 60 * 60 * 1000;

// Next creates the HTTP server internally. Wrap that one creation so large
// raw-body Hermes imports are not cut off by Node's five-minute default. Header
// parsing keeps Node's normal, separate header timeout limit.
const originalCreateServer = http.createServer;
http.createServer = function createServerWithToolPlaneTimeout(...args) {
  const server = originalCreateServer.apply(this, args);
  server.requestTimeout = requestTimeout;
  return server;
};

let serverPromise;
try {
  serverPromise = startServer({
    dir: appRoot,
    isDev: false,
    config: nextConfig,
    hostname,
    port,
    allowRetry: false,
    keepAliveTimeout,
  });
} finally {
  http.createServer = originalCreateServer;
}

Promise.resolve(serverPromise).catch((error) => {
  console.error(error);
  process.exit(1);
});
