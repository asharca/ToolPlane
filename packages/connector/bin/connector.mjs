#!/usr/bin/env node
import process from 'node:process';
import { main } from './runtime.mjs';

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
