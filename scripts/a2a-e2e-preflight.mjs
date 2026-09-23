#!/usr/bin/env node
/** Evidence-only prerequisite checks. This script never submits a task or approves a tool. */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
const command = (name, args) => {
  try { return spawnSync(name, args, { stdio: 'pipe', timeout: 10_000 }).status === 0; }
  catch { return false; }
};
const isStagingUrl = (value) => {
  try { const u = new URL(value); return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash; }
  catch { return false; }
};
const rows = [
  { check: 'docker_daemon', ready: command('docker', ['info', '--format', '{{.ServerVersion}}']), reason: 'Native CLI execution needs an actual isolated Docker runtime, not an executor stub.' },
  { check: 'explicit_staging_opt_in', ready: process.env.TOOLPLANE_E2E_STAGING === '1', reason: 'Real model/tool E2E must be explicitly authorized against isolated staging.' },
  { check: 'staging_app', ready: isStagingUrl(process.env.TOOLPLANE_E2E_APP_URL), reason: 'Configure a running isolated ToolPlane deployment with actual PostgreSQL.' },
  { check: 'staging_login', ready: Boolean(process.env.TOOLPLANE_E2E_EMAIL && process.env.TOOLPLANE_E2E_PASSWORD), reason: 'Browser decisions must use a real staging login, not fabricated session authorization.' },
  { check: 'actual_model_fixtures', ready: Boolean(process.env.TOOLPLANE_E2E_WORKSPACE && process.env.TOOLPLANE_E2E_AGENT_ID), reason: 'Provision isolated agents with actual model access and pinned native CLIs; identifiers alone are not acceptance evidence.' },
  { check: 'remote_tls_fixture', ready: isStagingUrl(process.env.TOOLPLANE_E2E_REMOTE_CARD_URL) && process.env.TOOLPLANE_E2E_REMOTE_CARD_URL?.startsWith('https:'), reason: 'An owned, approved HTTPS remote fixture is required. Do not disable TLS/SSRF protections for a test.' },
  { check: 'official_tck_checkout', ready: Boolean(process.env.TOOLPLANE_A2A_TCK_DIR && existsSync(resolve(process.env.TOOLPLANE_A2A_TCK_DIR, 'run_tck.py'))), reason: 'Run the unmodified pinned full upstream suite against the real authenticated service; no relay that fabricates protocol responses.' },
];
console.log(JSON.stringify({ status: rows.every(r => r.ready) ? 'prerequisites_present_not_e2e_passed' : 'blocked', checks: rows,
  actualE2EPassed: false, warning: 'No task execution, browser flow, model call, remote TLS acceptance or TCK certification is established by this preflight.' }, null, 2));
process.exitCode = rows.every(r => r.ready) ? 0 : 2;
