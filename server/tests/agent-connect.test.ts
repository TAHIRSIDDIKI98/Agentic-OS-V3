/**
 * Tests for the agent connect engine (Phase 2).
 *
 * These run entirely against a temp HOME: no database, no network, no real
 * agent config is touched.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ConnectError,
  applyPlannedWrites,
  detectedAgents,
  existingApiKey,
  isAgentConnected,
  planAgentConnect,
  type RuntimeEntry,
} from '../src/connectors/agent-connect.js';
import { AGENTS, findAgent, type AgentContext } from '../src/connectors/agent-registry.js';

let home: string;
const entry: RuntimeEntry = {
  origin: 'http://127.0.0.1:9900',
  apiKey: 'nx_test_key_123',
  transport: 'http',
};

function ctx(overrides: Partial<AgentContext> = {}): AgentContext {
  return { home, cwd: home, platform: 'linux', env: {}, ...overrides };
}

function agent(id: string) {
  const def = findAgent(id);
  if (!def) throw new Error(`missing agent ${id}`);
  return def;
}

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'nexus-connect-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('agent connect engine', () => {
  it('creates a config and is idempotent on re-run', () => {
    const def = agent('cursor');
    const path = join(home, '.cursor', 'mcp.json');

    const first = applyPlannedWrites(planAgentConnect(def, ctx(), entry));
    expect(first[0]!.action).toBe('create');
    expect(first[0]!.written).toBe(true);

    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    expect(parsed.mcpServers.nexus.url).toBe('http://127.0.0.1:9900/api/mcp');
    expect(parsed.mcpServers.nexus.headers.Authorization).toBe('Bearer nx_test_key_123');

    const before = readFileSync(path, 'utf8');
    const second = applyPlannedWrites(planAgentConnect(def, ctx(), entry));
    expect(second[0]!.action).toBe('unchanged');
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('preserves unrelated settings and backs up the previous file', () => {
    const def = agent('cursor');
    const path = join(home, '.cursor', 'mcp.json');
    const original = JSON.stringify(
      { theme: 'dark', mcpServers: { other: { command: 'other-server' } } },
      null,
      2
    );
    writeFile(path, original);

    applyPlannedWrites(planAgentConnect(def, ctx(), entry));

    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    expect(parsed.theme).toBe('dark');
    expect(parsed.mcpServers.other).toEqual({ command: 'other-server' });
    expect(readFileSync(`${path}.nexus-backup`, 'utf8')).toBe(original);
  });

  it('writes nothing in dry-run mode', () => {
    const def = agent('cursor');
    const path = join(home, '.cursor', 'mcp.json');

    const applied = applyPlannedWrites(planAgentConnect(def, ctx(), entry), { dryRun: true });

    expect(applied[0]!.action).toBe('create');
    expect(applied[0]!.written).toBe(false);
    expect(existsSync(path)).toBe(false);
  });

  it('uninstalls only the nexus entry', () => {
    const def = agent('cursor');
    const path = join(home, '.cursor', 'mcp.json');
    writeFile(path, JSON.stringify({ mcpServers: { other: { url: 'x' } } }, null, 2));
    applyPlannedWrites(planAgentConnect(def, ctx(), entry));
    expect(isAgentConnected(def, ctx())).toBe(true);

    const removed = applyPlannedWrites(planAgentConnect(def, ctx(), entry, { uninstall: true }));
    expect(removed[0]!.action).toBe('remove');

    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    expect(parsed.mcpServers).toEqual({ other: { url: 'x' } });
    expect(isAgentConnected(def, ctx())).toBe(false);

    const again = applyPlannedWrites(planAgentConnect(def, ctx(), entry, { uninstall: true }));
    expect(again[0]!.action).toBe('absent');
  });

  it('writes Codex TOML in a managed marker block', () => {
    const def = agent('codex');
    const path = join(home, '.codex', 'config.toml');
    writeFile(path, 'model = "gpt-5"\n');

    applyPlannedWrites(planAgentConnect(def, ctx(), entry));
    const text = readFileSync(path, 'utf8');
    expect(text).toContain('model = "gpt-5"');
    expect(text).toContain('# >>> nexus');
    expect(text).toContain('[mcp_servers.nexus]');
    expect(text).toContain('http_headers = { Authorization = "Bearer nx_test_key_123" }');

    const again = applyPlannedWrites(planAgentConnect(def, ctx(), entry));
    expect(again[0]!.action).toBe('unchanged');

    applyPlannedWrites(planAgentConnect(def, ctx(), entry, { uninstall: true }));
    const cleaned = readFileSync(path, 'utf8');
    expect(cleaned).toContain('model = "gpt-5"');
    expect(cleaned).not.toContain('mcp_servers.nexus');
  });

  it('refuses to fight a hand-written Codex table', () => {
    const def = agent('codex');
    writeFile(join(home, '.codex', 'config.toml'), '[mcp_servers.nexus]\nurl = "x"\n');

    expect(() => planAgentConnect(def, ctx(), entry)).toThrowError(ConnectError);
    expect(() => planAgentConnect(def, ctx(), entry)).toThrowError(/CONFLICT|without the nexus marker/);
  });

  it('never overwrites invalid JSON', () => {
    const def = agent('cursor');
    const path = join(home, '.cursor', 'mcp.json');
    writeFile(path, '{ not json');

    expect(() => planAgentConnect(def, ctx(), entry)).toThrowError(/not valid JSON/);
    expect(readFileSync(path, 'utf8')).toBe('{ not json');
  });

  it('adapts to the OpenCode config shape already present', () => {
    const def = agent('opencode');
    const path = join(home, '.config', 'opencode', 'opencode.json');

    writeFile(path, JSON.stringify({ mcp: { servers: { existing: { type: 'remote' } } } }, null, 2));
    applyPlannedWrites(planAgentConnect(def, ctx(), entry));
    let parsed = JSON.parse(readFileSync(path, 'utf8'));
    expect(parsed.mcp.servers.nexus).toMatchObject({ type: 'remote', url: 'http://127.0.0.1:9900/api/mcp' });
    expect(parsed.mcp.servers.existing).toEqual({ type: 'remote' });

    const legacyHome = mkdtempSync(join(tmpdir(), 'nexus-connect-v1-'));
    try {
      writeFile(join(legacyHome, '.config', 'opencode', 'opencode.json'), JSON.stringify({ mcp: { old: { type: 'remote' } } }));
      applyPlannedWrites(planAgentConnect(def, ctx({ home: legacyHome }), entry));
      parsed = JSON.parse(readFileSync(join(legacyHome, '.config', 'opencode', 'opencode.json'), 'utf8'));
      expect(parsed.mcp.nexus).toMatchObject({ type: 'remote' });
      expect(parsed.mcp.old).toEqual({ type: 'remote' });
    } finally {
      rmSync(legacyHome, { recursive: true, force: true });
    }
  });

  it('uses the servers key for VS Code and mcpServers for Claude Code', () => {
    applyPlannedWrites(planAgentConnect(agent('vscode'), ctx(), entry));
    const vscodePath = join(home, '.config', 'Code', 'User', 'mcp.json');
    expect(JSON.parse(readFileSync(vscodePath, 'utf8')).servers.nexus.type).toBe('http');

    applyPlannedWrites(planAgentConnect(agent('claude-code'), ctx(), entry));
    const claudePath = join(home, '.claude.json');
    expect(JSON.parse(readFileSync(claudePath, 'utf8')).mcpServers.nexus.url).toContain('/api/mcp');
  });

  it('round-trips the key so re-runs do not need a new principal', () => {
    const def = agent('cursor');
    applyPlannedWrites(planAgentConnect(def, ctx(), entry));
    expect(existingApiKey(def, ctx())).toBe('nx_test_key_123');
  });

  it('supports the stdio transport shape', () => {
    const def = agent('cursor');
    const stdioEntry: RuntimeEntry = {
      ...entry,
      transport: 'stdio',
      stdio: { command: 'node', args: ['/opt/nexus.js', 'mcp-stdio'], env: { NEXUS_API_KEY: 'nx_test_key_123' } },
    };
    applyPlannedWrites(planAgentConnect(def, ctx(), stdioEntry));
    const parsed = JSON.parse(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8'));
    expect(parsed.mcpServers.nexus).toEqual({
      command: 'node',
      args: ['/opt/nexus.js', 'mcp-stdio'],
      env: { NEXUS_API_KEY: 'nx_test_key_123' },
    });
  });

  it('detects only agents whose paths exist', () => {
    mkdirSync(join(home, '.cursor'), { recursive: true });
    mkdirSync(join(home, '.codex'), { recursive: true });
    const detected = detectedAgents(AGENTS, ctx()).map((def) => def.id);
    expect(detected).toContain('cursor');
    expect(detected).toContain('codex');
    expect(detected).not.toContain('windsurf');
  });
});
