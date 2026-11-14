#!/usr/bin/env node
/**
 * agent-connect-smoke.mjs — repeatable acceptance check for `nexus connect`.
 *
 * Runs the real CLI against a throwaway HOME:
 *   connect → file written with the scoped key
 *   connect again → idempotent ("already up to date")
 *   list → reports the agent as detected/connected
 *   uninstall → only the nexus entry is removed
 *
 * No network and no database: `--key` reuses a supplied key.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const NEXUS_CLI = join(ROOT, 'server', 'src', 'bin', 'nexus.ts');
const home = mkdtempSync(join(tmpdir(), 'nexus-connect-smoke-'));
const key = 'nx_connect_smoke_key_0123456789';

const checks = [];
function record(name, ok, detail = '') {
  checks.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function run(args) {
  const result = spawnSync(process.execPath, [TSX_CLI, NEXUS_CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, NEXUS_LOG_LEVEL: 'error', NEXUS_SQLITE_PATH: join(home, 'smoke.db') },
  });
  return { code: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

function main() {
  const cursorConfig = join(home, '.cursor', 'mcp.json');

  const first = run(['connect', 'cursor', '--home', home, '--key', key]);
  record('connect:cursor', first.code === 0 && existsSync(cursorConfig), first.out.trim().split('\n').slice(-2).join(' | '));

  const config = JSON.parse(readFileSync(cursorConfig, 'utf8'));
  record(
    'connect:scoped-key-written',
    config.mcpServers?.nexus?.headers?.Authorization === `Bearer ${key}`,
    config.mcpServers?.nexus?.url ?? 'missing'
  );

  const second = run(['connect', 'cursor', '--home', home, '--key', key]);
  record('connect:idempotent', second.code === 0 && /already up to date/i.test(second.out), second.out.trim());

  const claude = run(['connect', 'claude-code', '--home', home, '--key', key]);
  const settings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'));
  record(
    'connect:claude-hooks',
    claude.code === 0 && Object.keys(settings.hooks ?? {}).length === 4,
    Object.keys(settings.hooks ?? {}).join(', ')
  );

  const hook = spawnSync(process.execPath, [TSX_CLI, NEXUS_CLI, 'hook', 'recall'], {
    cwd: ROOT,
    encoding: 'utf8',
    input: JSON.stringify({ prompt: 'how do we deploy' }),
    env: { ...process.env, NEXUS_API_KEY: key, NEXUS_MCP_ORIGIN: 'http://127.0.0.1:1' },
  });
  record(
    'hook:fail-open-without-server',
    hook.status === 0 && (hook.stdout ?? '').trim() === '',
    `exit ${hook.status}, stdout ${JSON.stringify((hook.stdout ?? '').trim())}`
  );

  const list = run(['list', '--home', home]);
  record('list:detected-and-connected', /yes\s+yes/.test(list.out), list.out.trim().split('\n').slice(-1)[0] ?? '');

  const dryRun = run(['connect', 'cursor', '--home', home, '--key', key, '--dry-run', '--uninstall']);
  record('uninstall:dry-run-keeps-file', dryRun.code === 0 && existsSync(cursorConfig) && /dry-run/.test(dryRun.out));

  const uninstall = run(['connect', 'cursor', '--home', home, '--key', key, '--uninstall']);
  const after = JSON.parse(readFileSync(cursorConfig, 'utf8'));
  record(
    'uninstall:removes-only-nexus',
    uninstall.code === 0 && !after.mcpServers?.nexus && existsSync(`${cursorConfig}.nexus-backup`),
    JSON.stringify(after)
  );

  const failures = checks.filter((check) => !check.ok);
  console.log(`\n${checks.length - failures.length}/${checks.length} checks passed`);
  rmSync(home, { recursive: true, force: true });
  process.exit(failures.length ? 1 : 0);
}

main();
