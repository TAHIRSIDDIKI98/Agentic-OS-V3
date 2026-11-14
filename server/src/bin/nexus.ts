#!/usr/bin/env node
/**
 * bin/nexus.ts — the NEXUS hub CLI (Phase 2 surface).
 *
 *   nexus list                          which agents are installed / connected
 *   nexus connect <agent> [--all]       write MCP config for one agent or all
 *        [--dry-run] [--uninstall] [--print]
 *        [--transport http|stdio] [--origin URL] [--key RAW] [--home DIR] [--json]
 *   nexus mcp-stdio                     serve MCP over stdio (for agent configs)
 *
 * Design notes:
 *   - `list` and `--print` never touch the database.
 *   - a key is minted per agent (least privilege) only when the agent has no key
 *     already, so re-running is idempotent.
 *   - nothing is logged to stdout in stdio mode: stdout is the MCP channel.
 *
 * NOTE: server/src/cli.ts is frozen infrastructure and still hosts the legacy
 * commands; this file is the additive Phase 2 entrypoint (`bin: nexus`).
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AGENTS,
  agentIds,
  findAgent,
  type AgentContext,
  type AgentDefinition,
} from '../connectors/agent-registry.js';
import {
  ConnectError,
  applyPlannedWrites,
  detectedAgents,
  existingApiKey,
  isAgentConnected,
  planAgentConnect,
  planJsonTransform,
  type PlannedWrite,
  type RuntimeEntry,
  type Transport,
} from '../connectors/agent-connect.js';
import { mergeClaudeHooks, removeClaudeHooks, runHook } from '../connectors/agent-hooks.js';

const HERE = dirname(fileURLToPath(import.meta.url));

interface Args {
  _: string[];
  [key: string]: string | boolean | string[];
}

function parseArgs(argv: string[]): Args {
  const out: Args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function fail(message: string, code = 1): never {
  console.error(`nexus: ${message}`);
  process.exit(code);
}

function context(args: Args): AgentContext {
  return {
    home: typeof args.home === 'string' ? resolve(args.home) : homedir(),
    cwd: process.cwd(),
    platform: process.platform,
    env: process.env,
  };
}

function resolveOrigin(args: Args): string {
  if (typeof args.origin === 'string' && args.origin) return args.origin;
  const configured = process.env.NEXUS_MCP_ORIGIN;
  if (configured) return configured;
  return `http://127.0.0.1:${process.env.PORT && process.env.PORT !== '0' ? process.env.PORT : '9900'}`;
}

function transportOf(args: Args): Transport {
  const value = typeof args.transport === 'string' ? args.transport : 'http';
  if (value !== 'http' && value !== 'stdio') {
    fail(`unknown --transport "${value}" (expected http or stdio)`);
  }
  return value;
}

function stdioScript(): string {
  // Prefer the built entrypoint next to this file; fall back to the TS source
  // when running straight from src via tsx.
  return resolve(HERE, 'nexus.js');
}

/** Mint a least-privilege key for an agent, importing the DB lazily. */
async function issueKey(def: AgentDefinition): Promise<string> {
  const { db } = await import('../db/client.js');
  const { createPrincipal } = await import('../lib/security.js');
  const created = await createPrincipal(db, `agent:${def.id}`, def.scopes);
  console.error(
    `nexus: issued a scoped key for ${def.label} (${def.scopes.join(', ')}) — stored hashed server-side`
  );
  return created.rawKey;
}

function describePlan(
  def: AgentDefinition,
  plans: ReturnType<typeof planAgentConnect>,
  applied: ReturnType<typeof applyPlannedWrites>,
  json: boolean
): void {
  if (json) {
    console.log(
      JSON.stringify(
        { agent: def.id, files: applied.map((write) => ({ path: write.path, action: write.action, written: write.written })) },
        null,
        2
      )
    );
    return;
  }
  for (const write of applied) {
    const suffix = write.written ? '' : write.action === 'unchanged' ? ' (already up to date)' : ' (dry-run)';
    console.log(`  ${write.action.padEnd(9)} ${write.path}${suffix}`);
  }
  void plans;
}

async function commandList(args: Args): Promise<void> {
  const ctx = context(args);
  const json = Boolean(args.json);
  const rows = AGENTS.map((def) => ({
    agent: def.id,
    label: def.label,
    detected: def.detectPaths(ctx).some((path) => existsSync(path)),
    connected: isAgentConnected(def, ctx),
    caveat: def.caveat ?? null,
  }));

  if (json) {
    console.log(JSON.stringify({ agents: rows }, null, 2));
    return;
  }
  const width = Math.max(...rows.map((row) => row.label.length));
  console.log(`${'AGENT'.padEnd(width)}  DETECTED  CONNECTED`);
  for (const row of rows) {
    console.log(
      `${row.label.padEnd(width)}  ${(row.detected ? 'yes' : 'no').padEnd(8)}  ${row.connected ? 'yes' : 'no'}`
    );
    if (row.caveat) console.log(`${' '.repeat(width)}  ! ${row.caveat}`);
  }
}

async function connectOne(
  def: AgentDefinition,
  ctx: AgentContext,
  args: Args
): Promise<number> {
  const dryRun = Boolean(args['dry-run']);
  const uninstall = Boolean(args.uninstall);

  if (uninstall) {
    const applied = applyPlannedWrites(planAgentConnect(def, ctx, placeholderEntry(args), { uninstall }), {
      dryRun,
    });
    console.log(`${def.label}:`);
    describePlan(def, [], applied, Boolean(args.json));
    return applied.some((write) => write.action === 'remove') ? 1 : 0;
  }

  const key =
    (typeof args.key === 'string' ? args.key : null) ??
    existingApiKey(def, ctx) ??
    (dryRun ? 'nx_dryrun_key' : await issueKey(def));

  const transport = transportOf(args);
  const entry: RuntimeEntry = {
    origin: resolveOrigin(args),
    apiKey: key,
    transport,
    stdio:
      transport === 'stdio'
        ? {
            command: process.execPath,
            args: [stdioScript(), 'mcp-stdio'],
            env: {
              NEXUS_API_KEY: key,
              ...(process.env.NEXUS_SQLITE_PATH ? { NEXUS_SQLITE_PATH: process.env.NEXUS_SQLITE_PATH } : {}),
            },
          }
        : undefined,
  };

  const plans: PlannedWrite[] = planAgentConnect(def, ctx, entry);
  if (def.hooks === 'claude-code') {
    const settingsPath = join(ctx.home, '.claude', 'settings.json');
    plans.push(
      planJsonTransform(settingsPath, (current) =>
        uninstall ? removeClaudeHooks(current) : mergeClaudeHooks(current, stdioScript())
      )
    );
  }

  if (args.print) {
    for (const plan of plans) {
      console.log(`# ${plan.path}\n${plan.content}`);
    }
    return 0;
  }

  const applied = applyPlannedWrites(plans, { dryRun });
  console.log(`${def.label}:`);
  describePlan(def, plans, applied, Boolean(args.json));
  if (!dryRun && applied.some((write) => write.written)) {
    console.log(`  key: ${key.slice(0, 12)}… (full key written to the agent config only)`);
  }
  if (def.caveat && !args.json) console.log(`  ! ${def.caveat}`);
  return applied.filter((write) => write.action !== 'unchanged').length;
}

function placeholderEntry(args: Args): RuntimeEntry {
  return { origin: resolveOrigin(args), apiKey: 'unused', transport: 'http' };
}

function printGeneric(args: Args): void {
  const origin = resolveOrigin(args);
  const key = typeof args.key === 'string' ? args.key : '<NEXUS_API_KEY>';
  const config = {
    mcpServers: {
      nexus: { url: `${origin.replace(/\/$/, '')}/api/mcp`, headers: { Authorization: `Bearer ${key}` } },
    },
  };
  console.log(JSON.stringify(config, null, 2));
}

async function commandConnect(args: Args): Promise<void> {
  const ctx = context(args);
  const requested = args._[1];
  const all = Boolean(args.all);

  if (!requested && !all) {
    console.log(`Available agents: ${agentIds().join(', ')}`);
    console.log('Usage: nexus connect <agent> | --all [--dry-run] [--uninstall] [--transport http|stdio]');
    process.exit(0);
  }

  if (all) {
    const targets = detectedAgents(AGENTS, ctx).filter((def) => def.id !== 'generic');
    if (!targets.length) {
      console.log('No supported agents detected on this machine.');
      return;
    }
    let changes = 0;
    for (const def of targets) changes += await connectOne(def, ctx, args);
    console.log(
      changes ? `\n${changes} file(s) ${args['dry-run'] ? 'would change' : 'changed'}.` : '\nEverything already up to date.'
    );
    return;
  }

  const def = findAgent(requested!);
  if (!def) fail(`unknown agent "${requested}" (expected one of: ${agentIds().join(', ')})`);
  if (def.id === 'generic') {
    printGeneric(args);
    return;
  }
  await connectOne(def, ctx, args);
}

async function commandMcpStdio(): Promise<void> {
  // stdout is the MCP transport: silence info/debug logs before anything loads.
  process.env.NEXUS_LOG_LEVEL = process.env.NEXUS_LOG_LEVEL ?? 'error';

  const raw = process.env.NEXUS_STDIO_API_KEY ?? process.env.NEXUS_API_KEY;
  if (!raw) {
    fail('stdio transport requires NEXUS_API_KEY (or NEXUS_STDIO_API_KEY) in the environment');
  }

  const { db } = await import('../db/client.js');
  const { authenticate } = await import('../lib/security.js');
  const principal = await authenticate(db, raw);
  if (!principal) fail('the provided API key is not valid or is disabled');

  const { createNexusMcpServer } = await import('../mcp.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const server = createNexusMcpServer(principal.id, principal.scopes);
  await server.connect(new StdioServerTransport());
  console.error(
    `nexus mcp-stdio: serving ${principal.scopes.length} scopes for principal ${principal.id}`
  );
}

/** Read all of stdin (hook payloads are small JSON documents). */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * `nexus hook recall|capture` — called by the agent's hook runner.
 * Fail open: missing key, bad JSON, slow server or a network error all exit 0
 * with no stdout so the agent is never blocked.
 */
async function commandHook(args: Args): Promise<void> {
  const action = args._[1] ?? 'recall';
  process.env.NEXUS_LOG_LEVEL = process.env.NEXUS_LOG_LEVEL ?? 'error';
  const apiKey = process.env.NEXUS_API_KEY ?? process.env.NEXUS_STDIO_API_KEY;
  if (!apiKey) return;
  try {
    const stdout = await runHook({
      action,
      stdin: await readStdin(),
      config: { origin: resolveOrigin(args), apiKey },
    });
    if (stdout) process.stdout.write(`${stdout}\n`);
  } catch {
    // Never surface hook failures to the agent.
  }
}

function printHelp(): void {
  console.log(`NEXUS hub CLI

  list                              installed / connected agents
  connect <agent>                   write MCP config for one agent
  connect --all                     every detected agent
      --dry-run                     show changes without writing
      --uninstall                   remove only the nexus entry
      --print                       print the config instead of writing it
      --transport http|stdio        how the agent reaches NEXUS (default http)
      --origin URL                  NEXUS origin (default http://127.0.0.1:9900)
      --key RAW                     reuse an existing API key
      --home DIR                    alternate home directory (testing)
      --json                        machine-readable output
  mcp-stdio                         serve MCP on stdio (reads NEXUS_API_KEY)
  hook recall|capture               hook runtime used by agent integrations

Agents: ${agentIds().join(', ')}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  try {
    switch (command) {
      case undefined:
      case 'help':
        printHelp();
        return;
      case 'list':
        await commandList(args);
        return;
      case 'connect':
        await commandConnect(args);
        return;
      case 'mcp-stdio':
        await commandMcpStdio();
        return;
      case 'hook':
        await commandHook(args);
        return;
      default:
        fail(`unknown command "${command}" (try: nexus help)`);
    }
  } catch (error) {
    if (error instanceof ConnectError) fail(`${error.code}: ${error.message}`);
    fail(error instanceof Error ? error.message : String(error));
  }
}

void main();
