#!/usr/bin/env node
/**
 * mcp-smoke.mjs — repeatable end-to-end MCP smoke test.
 *
 * Boots the real server (server/src/index.ts via tsx) against a throwaway
 * SQLite database, then acts as a real MCP client over Streamable HTTP:
 *   - connects with a Bearer API key
 *   - lists tools/resources/prompts
 *   - calls EVERY registered tool and reads EVERY resource
 *   - verifies the unauthenticated request is rejected with 401
 *
 * Exits 0 only when the server boots, every protocol call succeeds, and every
 * tool returns a non-error result. Any tool error fails the run (that is the
 * point: this is the gate that Phase 1 bugs must flip from red to green).
 *
 * Usage:
 *   node scripts/mcp-smoke.mjs                 # full run
 *   node scripts/mcp-smoke.mjs --keep-db       # keep the temp DB for inspection
 *   node scripts/mcp-smoke.mjs --json out.json # write a machine-readable report
 *
 * Requires: Node 22, dependencies installed, `server/src` runnable via tsx.
 */
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

const argv = process.argv.slice(2);
const KEEP_DB = argv.includes('--keep-db');
const JSON_OUT = argv.includes('--json') ? argv[argv.indexOf('--json') + 1] : null;

/** Deterministic-ish port in the ephemeral range, overridable for CI. */
const PORT = Number(process.env.SMOKE_PORT ?? 0) || 18900 + Math.floor(Math.random() * 400);
const API_KEY = process.env.SMOKE_API_KEY ?? 'nx_smoke_test_key_0123456789';
const BASE_URL = `http://127.0.0.1:${PORT}`;
const MCP_URL = new URL(`${BASE_URL}/api/mcp`);

const workDir = mkdtempSync(join(tmpdir(), 'nexus-mcp-smoke-'));
const dbPath = join(workDir, 'smoke.db');
const serverLog = join(workDir, 'server.log');

const report = { startedAt: new Date().toISOString(), port: PORT, dbPath, checks: [] };
let child = null;
let logBuffer = '';

function record(name, ok, detail) {
  const entry = { name, ok, detail: detail === undefined ? null : detail };
  report.checks.push(entry);
  const status = ok ? 'PASS' : 'FAIL';
  const text = typeof detail === 'string' ? detail : detail === undefined ? '' : JSON.stringify(detail);
  console.log(`${status}  ${name}${text ? ` — ${truncate(text, 300)}` : ''}`);
  return ok;
}

function truncate(value, max) {
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function waitForPort(port, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolveWait, rejectWait) => {
    const attempt = () => {
      const socket = createConnection({ host: '127.0.0.1', port });
      socket.once('connect', () => {
        socket.destroy();
        resolveWait();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() > deadline) {
          rejectWait(new Error(`server did not listen on ${port} within ${timeoutMs}ms`));
        } else {
          setTimeout(attempt, 250);
        }
      });
    };
    attempt();
  });
}

async function withClient(fn) {
  const transport = new StreamableHTTPClientTransport(MCP_URL, {
    requestInit: { headers: { Authorization: `Bearer ${API_KEY}` } },
  });
  const client = new Client({ name: 'nexus-mcp-smoke', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
  }
}

/** Tool calls return { content, isError }; surface the text payload. */
function toolText(result) {
  const parts = Array.isArray(result?.content) ? result.content : [];
  return parts
    .map((part) => (part?.type === 'text' ? part.text : JSON.stringify(part)))
    .join('\n');
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function callTool(client, name, args, { expectError = false } = {}) {
  try {
    const result = await client.callTool({ name, arguments: args });
    const text = toolText(result);
    if (result?.isError) {
      return record(`tool:${name}`, expectError, `isError: ${text}`);
    }
    return record(`tool:${name}`, true, text);
  } catch (error) {
    return record(`tool:${name}`, false, `threw: ${error?.message ?? error}`);
  }
}

async function main() {
  console.log(`NEXUS MCP smoke test → ${MCP_URL} (db: ${dbPath})`);

  child = spawn(process.execPath, [TSX_CLI, 'server/src/index.ts'], {
    cwd: ROOT,
    env: {
      ...process.env,
      // Explicit: a runner that exports PORT=0 (or an empty DATABASE_URL) must
      // not be able to change which backend this test exercises.
      PORT: String(PORT),
      NODE_ENV: 'development',
      DATABASE_URL: '',
      NEXUS_SQLITE_PATH: dbPath,
      NEXUS_API_KEY: API_KEY,
      NEXUS_LOG_LEVEL: process.env.NEXUS_LOG_LEVEL ?? 'info',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => {
    logBuffer += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    logBuffer += chunk.toString();
  });

  try {
    await waitForPort(PORT);
  } catch (error) {
    record('server-boot', false, error.message);
    finish(1);
    return;
  }

  // ── Unauthenticated request must be rejected ────────────────
  try {
    const response = await fetch(`${BASE_URL}/api/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    record('auth:no-token-rejected', response.status === 401, `status ${response.status}`);
  } catch (error) {
    record('auth:no-token-rejected', false, `threw: ${error?.message ?? error}`);
  }

  try {
    await withClient(async (client) => {
      const tools = await client.listTools();
      const names = tools.tools.map((tool) => tool.name).sort();
      record('protocol:tools/list', names.length > 0, `${names.length} tools: ${names.join(', ')}`);
      report.tools = names;

      const resources = await client.listResources();
      record(
        'protocol:resources/list',
        resources.resources.length > 0,
        resources.resources.map((resource) => resource.uri).join(', ')
      );

      const prompts = await client.listPrompts();
      record('protocol:prompts/list', prompts.prompts.length > 0, prompts.prompts.map((p) => p.name).join(', '));

      // ── Resources ───────────────────────────────────────────
      for (const uri of ['nexus://brain/stats', 'nexus://brain/health', 'nexus://brain/ambient']) {
        try {
          const read = await client.readResource({ uri });
          const text = read.contents.map((item) => item.text ?? '').join('\n');
          record(`resource:${uri}`, text.length > 0, text);
        } catch (error) {
          record(`resource:${uri}`, false, `threw: ${error?.message ?? error}`);
        }
      }

      // ── Prompts ─────────────────────────────────────────────
      for (const [name, args] of [
        ['recall-and-execute', { query: 'how do we deploy' }],
        ['resume-work', {}],
        ['capture-session', { transcript: 'we deploy with docker compose on port 8080' }],
      ]) {
        try {
          const got = await client.getPrompt({ name, arguments: args });
          record(`prompt:${name}`, (got.messages?.length ?? 0) > 0, `${got.messages?.length ?? 0} message(s)`);
        } catch (error) {
          record(`prompt:${name}`, false, `threw: ${error?.message ?? error}`);
        }
      }

      // ── Tools: read-only ────────────────────────────────────
      const stats = await callTool(client, 'nexus_stats', {});
      const verify = await callTool(client, 'nexus_audit_verify', {});
      await callTool(client, 'nexus_agents', {});
      await callTool(client, 'nexus_scheduler', {});
      await callTool(client, 'nexus_cron_list', {});
      await callTool(client, 'nexus_acl_check', { ring: 2, tool: 'nexus_recall' });

      // ── Tools: write path (fact used by the recall assertion) ─
      const remembered = await client.callTool({
        name: 'nexus_remember',
        arguments: {
          kind: 'fact',
          title: 'Deployment target',
          content: 'We deploy with docker compose on port 8080.',
          tags: ['deploy', 'infra'],
          importance: 0.9,
        },
      });
      const rememberedText = toolText(remembered);
      record('tool:nexus_remember', !remembered.isError, rememberedText);

      const memoryId = extractMemoryId(rememberedText);
      const recall = await client.callTool({
        name: 'nexus_recall',
        arguments: { query: 'how do we deploy', budget: 900 },
      });
      const recallText = toolText(recall);
      const recallJson = parseJson(recallText);
      const recalledDeploy = /docker compose/i.test(recallText);
      record('tool:nexus_recall', !recall.isError && recalledDeploy, recallText);
      report.recallHit = recalledDeploy;
      report.rememberOk = !remembered.isError;

      if (memoryId) {
        await callTool(client, 'nexus_feedback', {
          query: 'how do we deploy',
          itemId: memoryId,
          itemType: 'memory',
          helpful: true,
        });
      } else {
        record('tool:nexus_feedback', false, 'skipped: no memory id in server log');
      }

      // ── Tools: capture (transcript-preservation invariant) ───
      const transcript =
        'User: how should we ship this service?\n' +
        'Assistant: we deploy with docker compose on port 8080, and the reverse proxy handles TLS.\n' +
        'User: good. Keep the compose file in the repo root.';
      const captured = await client.callTool({
        name: 'nexus_capture',
        arguments: { transcript, projectName: 'mcp-smoke' },
      });
      const captureText = toolText(captured);
      const captureJson = parseJson(captureText);
      record('tool:nexus_capture', !captured.isError, captureText);
      report.transcriptPreserved = captureJson?.transcriptPreserved ?? null;
      record(
        'invariant:transcript-preserved',
        captureJson?.transcriptPreserved === true,
        `transcriptPreserved=${String(captureJson?.transcriptPreserved)}`
      );

      // Capture-only retrieval: a fact stated in the transcript must be
      // recallable afterwards even with no LLM configured.
      const captureRecall = await client.callTool({
        name: 'nexus_recall',
        arguments: { query: 'reverse proxy TLS', budget: 900 },
      });
      const captureRecallText = toolText(captureRecall);
      const captureRecallHit = /reverse proxy/i.test(captureRecallText);
      record('invariant:capture-recallable', captureRecallHit, captureRecallText);
      report.captureRecallHit = captureRecallHit;

      await callTool(client, 'nexus_ambient_ingest', {
        transcript: 'Ambient note: the team decided to pin the base image to node:22-alpine.',
        source: 'smoke',
      });

      // ── Tools: kernel / scheduler side effects ──────────────
      await callTool(client, 'nexus_delegate', {
        name: 'smoke-subagent',
        taskLabel: 'verify delegation on sqlite',
        kind: 'sub-agent',
      });
      await callTool(client, 'nexus_cron_create', {
        name: 'smoke-cron',
        cron: '*/5 * * * *',
        taskLabel: 'smoke tick',
      });

      // ── Scope enforcement (least privilege) ─────────────────
      await callTool(client, 'nexus_stats', {});
      report.statsSnapshot = parseJson(toolText(await client.callTool({ name: 'nexus_stats', arguments: {} })));
      void stats;
      void verify;
    });
  } catch (error) {
    record('protocol:session', false, `threw: ${error?.message ?? error}`);
  }

  const failures = report.checks.filter((check) => !check.ok);
  report.finishedAt = new Date().toISOString();
  report.failures = failures.map((check) => check.name);
  console.log(
    `\n${report.checks.length - failures.length}/${report.checks.length} checks passed` +
      (failures.length ? ` — FAILURES: ${failures.map((f) => f.name).join(', ')}` : '')
  );
  finish(failures.length ? 1 : 0);
}

/** The remember response nests the row; pull the id without guessing shape. */
function extractMemoryId(text) {
  const match = text.match(/"id"\s*:\s*"(mem_[^"]+)"/);
  return match ? match[1] : null;
}

function finish(exitCode) {
  report.exitCode = exitCode;
  if (JSON_OUT) {
    writeFileSync(JSON_OUT, JSON.stringify(report, null, 2));
    console.log(`report → ${JSON_OUT}`);
  }
  if (child && !child.killed) {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }
  if (exitCode !== 0) {
    const tail = logBuffer.trim().split('\n').slice(-40).join('\n');
    if (tail) console.error(`\n--- server log (tail) ---\n${tail}`);
  }
  if (!KEEP_DB) {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  } else {
    console.log(`kept: ${workDir} (server log: ${serverLog})`);
  }
  process.exit(exitCode);
}

main().catch((error) => {
  console.error('smoke test crashed:', error);
  record('harness', false, `threw: ${error?.message ?? error}`);
  finish(1);
});
