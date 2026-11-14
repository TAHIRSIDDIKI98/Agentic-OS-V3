#!/usr/bin/env node
/**
 * mcp-stdio-smoke.mjs — end-to-end check of `nexus mcp-stdio`.
 *
 * 1. Boots the HTTP server once against a throwaway SQLite DB so the operator
 *    principal exists (it also proves the same key is valid for both transports).
 * 2. Stops it and speaks MCP over stdio to `nexus mcp-stdio` with the SDK client.
 * 3. Writes a memory, recalls it, and verifies stdout stayed protocol-clean —
 *    any stray log line on stdout corrupts the transport and fails the client.
 *
 * Exit 0 only when every step passes.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const NEXUS_CLI = join(ROOT, 'server', 'src', 'bin', 'nexus.ts');

const port = 19400 + Math.floor(Math.random() * 300);
const apiKey = 'nx_stdio_smoke_key_0123456789';
const workDir = mkdtempSync(join(tmpdir(), 'nexus-stdio-smoke-'));
const dbPath = join(workDir, 'smoke.db');

const checks = [];
function record(name, ok, detail = '') {
  checks.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function waitForPort(targetPort, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolveWait, rejectWait) => {
    const attempt = () => {
      const socket = createConnection({ host: '127.0.0.1', port: targetPort });
      socket.once('connect', () => {
        socket.destroy();
        resolveWait();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() > deadline) rejectWait(new Error('server did not start'));
        else setTimeout(attempt, 200);
      });
    };
    attempt();
  });
}

const baseEnv = {
  ...process.env,
  PORT: String(port),
  NODE_ENV: 'development',
  DATABASE_URL: '',
  NEXUS_SQLITE_PATH: dbPath,
  NEXUS_API_KEY: apiKey,
  NEXUS_LOG_LEVEL: 'error',
};

async function seedPrincipal() {
  const server = spawn(process.execPath, [TSX_CLI, 'server/src/index.ts'], {
    cwd: ROOT,
    env: baseEnv,
    stdio: 'ignore',
  });
  try {
    await waitForPort(port);
  } finally {
    server.kill();
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function main() {
  console.log(`NEXUS stdio smoke → ${NEXUS_CLI} (db: ${dbPath})`);
  await seedPrincipal();
  record('seed:server-boot', true);

  // Prove the actual one-command path: `nexus connect` mints a least-privilege
  // key and that key (not the operator key) drives the stdio session.
  const connect = spawnSync(
    process.execPath,
    [TSX_CLI, NEXUS_CLI, 'connect', 'cursor', '--home', workDir, '--json'],
    { cwd: ROOT, env: baseEnv, encoding: 'utf8' }
  );
  const configPath = join(workDir, '.cursor', 'mcp.json');
  const scopedKey = JSON.parse(readFileSync(configPath, 'utf8')).mcpServers.nexus.headers.Authorization.replace(
    /^Bearer /,
    ''
  );
  record('cli:mint-scoped-key', connect.status === 0 && scopedKey.startsWith('nk_'), `${scopedKey.slice(0, 10)}…`);

  let stderr = '';
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [TSX_CLI, NEXUS_CLI, 'mcp-stdio'],
    env: { ...baseEnv, NEXUS_API_KEY: scopedKey },
    stderr: 'pipe',
  });
  // Capture stderr so diagnostics never leak into the result but are visible on failure.
  transport.stderr?.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  const client = new Client({ name: 'nexus-stdio-smoke', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  record('protocol:connect', true);

  const tools = await client.listTools();
  record('protocol:tools/list', tools.tools.length === 13, `${tools.tools.length} tools`);

  const remembered = await client.callTool({
    name: 'nexus_remember',
    arguments: {
      kind: 'fact',
      title: 'stdio transport works',
      content: 'Memories written over stdio are visible over stdio recall.',
      tags: ['smoke'],
      importance: 0.7,
    },
  });
  const rememberedText = remembered.content?.find((part) => part.type === 'text')?.text ?? '';
  record('tool:nexus_remember', !remembered.isError, rememberedText.slice(0, 120));

  const recalled = await client.callTool({
    name: 'nexus_recall',
    arguments: { query: 'stdio transport', budget: 800 },
  });
  const recalledText = recalled.content?.find((part) => part.type === 'text')?.text ?? '';
  record('tool:nexus_recall', /stdio transport works/i.test(recalledText), recalledText.slice(0, 120));

  await client.close();
  record('protocol:clean-shutdown', true);

  const failures = checks.filter((check) => !check.ok);
  console.log(`\n${checks.length - failures.length}/${checks.length} checks passed`);
  if (failures.length && stderr) console.error(`\n--- stderr ---\n${stderr.split('\n').slice(-25).join('\n')}`);
  rmSync(workDir, { recursive: true, force: true });
  process.exit(failures.length ? 1 : 0);
}

main().catch((error) => {
  console.error('stdio smoke crashed:', error);
  rmSync(workDir, { recursive: true, force: true });
  process.exit(1);
});
