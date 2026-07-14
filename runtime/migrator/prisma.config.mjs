import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'prisma/config';

const configDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = [
  path.resolve(configDir, '..'),
  path.resolve(configDir, '../..'),
  path.resolve(configDir, '../../..'),
].find((candidate) => existsSync(path.join(candidate, 'prisma/schema.prisma')));

if (!appRoot) {
  throw new Error('Unable to locate ToolPlane prisma/schema.prisma');
}

export default defineConfig({
  schema: path.join(appRoot, 'prisma/schema.prisma'),
  migrations: {
    path: path.join(appRoot, 'prisma/migrations'),
  },
  datasource: {
    url: process.env.DATABASE_URL,
  },
});
