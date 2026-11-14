/**
 * connectors/agent-connect.ts — idempotent MCP config writer for coding agents.
 *
 * Guarantees:
 *   - only the `nexus` entry is touched; unrelated settings are preserved
 *   - an existing file is backed up before it is modified
 *   - re-running is a no-op (`unchanged`) once the entry is in place
 *   - `--uninstall` removes only what this connector wrote
 *   - invalid JSON/TOML is reported and NEVER overwritten
 *   - dry-run computes every write without touching the disk
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AgentContext, AgentDefinition, AgentTarget } from './agent-registry.js';

export type Transport = 'http' | 'stdio';

export interface RuntimeEntry {
  origin: string;
  apiKey: string;
  transport: Transport;
  /** Absolute command used for the stdio transport. */
  stdio?: { command: string; args: string[]; env: Record<string, string> };
  /** Server key under the agent's MCP section. */
  serverName?: string;
}

export interface PlannedWrite {
  agentId: string;
  path: string;
  format: 'json' | 'toml';
  action: 'create' | 'update' | 'unchanged' | 'remove' | 'absent';
  content: string;
  /** Previous content, written to `<path>.nexus-backup` when action is update/remove. */
  backup?: string;
}

export class ConnectError extends Error {
  constructor(
    readonly code: 'INVALID_CONFIG' | 'UNSUPPORTED' | 'CONFLICT',
    message: string
  ) {
    super(message);
    this.name = 'ConnectError';
  }
}

const SERVER_NAME = 'nexus';
const MARKER_START = '# >>> nexus (managed by `nexus connect`; this block is overwritten) >>>';
const MARKER_END = '# <<< nexus <<<';

function targetKey(kind: AgentTarget['kind'], existing: Record<string, unknown>): string[] {
  switch (kind) {
    case 'mcpServers':
    case 'projectMcp':
      return ['mcpServers'];
    case 'vscodeServers':
      return ['servers'];
    case 'opencodeMcp': {
      // OpenCode 2 nests servers under mcp.servers; v1 puts them directly under mcp.
      const mcp = existing.mcp;
      if (mcp && typeof mcp === 'object' && 'servers' in (mcp as Record<string, unknown>)) {
        return ['mcp', 'servers'];
      }
      if (mcp && typeof mcp === 'object') return ['mcp'];
      return ['mcp', 'servers'];
    }
    case 'codexToml':
      throw new ConnectError('UNSUPPORTED', 'codex TOML is rendered as text, not a JSON path');
  }
}

function buildJsonEntry(kind: AgentTarget['kind'], entry: RuntimeEntry): unknown {
  if (entry.transport === 'stdio') {
    const stdio = entry.stdio;
    if (!stdio) throw new ConnectError('UNSUPPORTED', 'stdio transport requires a command');
    if (kind === 'opencodeMcp') {
      return {
        type: 'local',
        command: [stdio.command, ...stdio.args],
        environment: stdio.env,
        enabled: true,
      };
    }
    return { command: stdio.command, args: stdio.args, env: stdio.env };
  }

  const url = `${entry.origin.replace(/\/$/, '')}/api/mcp`;
  const headers = { Authorization: `Bearer ${entry.apiKey}` };
  switch (kind) {
    case 'vscodeServers':
      return { type: 'http', url, headers };
    case 'opencodeMcp':
      return { type: 'remote', url, enabled: true, oauth: false, headers };
    default:
      return { url, headers };
  }
}

function detectIndent(text: string): number {
  const match = text.match(/\n( +)"/);
  return match ? match[1]!.length : 2;
}

function readJson(path: string): { exists: boolean; text: string; value: Record<string, unknown> } {
  if (!existsSync(path)) return { exists: false, text: '', value: {} };
  const text = readFileSync(path, 'utf8');
  if (!text.trim()) return { exists: true, text, value: {} };
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ConnectError('INVALID_CONFIG', `${path} does not contain a JSON object`);
    }
    return { exists: true, text, value: parsed as Record<string, unknown> };
  } catch (error) {
    if (error instanceof ConnectError) throw error;
    throw new ConnectError(
      'INVALID_CONFIG',
      `${path} is not valid JSON (${error instanceof Error ? error.message : String(error)}); left untouched`
    );
  }
}

function getIn(value: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** Immutably set a nested key, creating intermediate objects. */
function setIn(
  value: Record<string, unknown>,
  path: string[],
  entryKey: string,
  entryValue: unknown
): Record<string, unknown> {
  const clone = structuredClone(value);
  let current: Record<string, unknown> = clone;
  for (const key of path) {
    const next = current[key];
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  current[entryKey] = entryValue;
  return clone;
}

function deleteIn(value: Record<string, unknown>, path: string[], entryKey: string): Record<string, unknown> {
  const clone = structuredClone(value);
  let current: Record<string, unknown> = clone;
  for (const key of path) {
    const next = current[key];
    if (!next || typeof next !== 'object') return clone;
    current = next as Record<string, unknown>;
  }
  delete current[entryKey];
  // Drop the section if this connector emptied it.
  if (Object.keys(current).length === 0 && path.length > 0) {
    let parent: Record<string, unknown> = clone;
    for (const key of path.slice(0, -1)) {
      parent = parent[key] as Record<string, unknown>;
    }
    delete parent[path[path.length - 1]!];
  }
  return clone;
}

function renderJson(value: Record<string, unknown>, indent: number): string {
  return `${JSON.stringify(value, null, indent)}\n`;
}

function renderTomlBlock(entry: RuntimeEntry, serverName: string): string {
  const lines = [MARKER_START];
  if (entry.transport === 'stdio') {
    const stdio = entry.stdio;
    if (!stdio) throw new ConnectError('UNSUPPORTED', 'stdio transport requires a command');
    lines.push(`[mcp_servers.${serverName}]`);
    lines.push(`command = ${JSON.stringify(stdio.command)}`);
    lines.push(`args = ${JSON.stringify(stdio.args)}`);
    const envKeys = Object.keys(stdio.env);
    if (envKeys.length) {
      lines.push('');
      lines.push(`[mcp_servers.${serverName}.env]`);
      for (const key of envKeys) lines.push(`${key} = ${JSON.stringify(stdio.env[key])}`);
    }
  } else {
    lines.push(`[mcp_servers.${serverName}]`);
    lines.push(`url = ${JSON.stringify(`${entry.origin.replace(/\/$/, '')}/api/mcp`)}`);
    lines.push(`http_headers = { Authorization = ${JSON.stringify(`Bearer ${entry.apiKey}`)} }`);
  }
  lines.push(MARKER_END);
  return `${lines.join('\n')}\n`;
}

const BLOCK_RE = /^# >>> nexus[\s\S]*?^# <<< nexus[^\n]*\n?/m;

function planToml(target: AgentTarget, entry: RuntimeEntry, remove: boolean): PlannedWrite {
  const exists = existsSync(target.path);
  const text = exists ? readFileSync(target.path, 'utf8') : '';
  const hasBlock = BLOCK_RE.test(text);

  if (remove) {
    if (!hasBlock) {
      return { agentId: '', path: target.path, format: 'toml', action: 'absent', content: text };
    }
    const content = text.replace(BLOCK_RE, '').replace(/\n{3,}/g, '\n\n');
    return {
      agentId: '',
      path: target.path,
      format: 'toml',
      action: 'remove',
      content,
      backup: text,
    };
  }

  const block = renderTomlBlock(entry, entry.serverName ?? SERVER_NAME);
  if (hasBlock) {
    const content = text.replace(BLOCK_RE, block);
    return {
      agentId: '',
      path: target.path,
      format: 'toml',
      action: content === text ? 'unchanged' : 'update',
      content,
      backup: content === text ? undefined : text,
    };
  }
  if (new RegExp(`^\\[mcp_servers\\.${entry.serverName ?? SERVER_NAME}\\]`, 'm').test(text)) {
    throw new ConnectError(
      'CONFLICT',
      `${target.path} already defines [mcp_servers.${entry.serverName ?? SERVER_NAME}] without the nexus marker block; ` +
        'remove or rename that table so this connector can manage it safely'
    );
  }
  const content = text.trimEnd().length ? `${text.trimEnd()}\n\n${block}` : block;
  return {
    agentId: '',
    path: target.path,
    format: 'toml',
    action: exists ? 'update' : 'create',
    content,
    backup: exists ? text : undefined,
  };
}

function planJson(target: AgentTarget, entry: RuntimeEntry, remove: boolean): PlannedWrite {
  const file = readJson(target.path);
  const path = targetKey(target.kind, file.value);
  const serverName = entry.serverName ?? SERVER_NAME;
  const indent = detectIndent(file.text);

  if (remove) {
    const section = getIn(file.value, path);
    if (!section || typeof section !== 'object' || !(serverName in (section as object))) {
      return { agentId: '', path: target.path, format: 'json', action: 'absent', content: file.text };
    }
    const content = renderJson(deleteIn(file.value, path, serverName), indent);
    return {
      agentId: '',
      path: target.path,
      format: 'json',
      action: 'remove',
      content,
      backup: file.text,
    };
  }

  const entryValue = buildJsonEntry(target.kind, entry);
  const next = setIn(file.value, path, serverName, entryValue);
  const content = renderJson(next, indent);
  if (file.exists && content === file.text) {
    return { agentId: '', path: target.path, format: 'json', action: 'unchanged', content };
  }
  return {
    agentId: '',
    path: target.path,
    format: 'json',
    action: file.exists ? 'update' : 'create',
    content,
    backup: file.exists ? file.text : undefined,
  };
}

function planTarget(
  def: AgentDefinition,
  target: AgentTarget,
  entry: RuntimeEntry,
  remove: boolean
): PlannedWrite {
  const planned =
    target.format === 'toml' ? planToml(target, entry, remove) : planJson(target, entry, remove);
  return { ...planned, agentId: def.id };
}

export function planAgentConnect(
  def: AgentDefinition,
  ctx: AgentContext,
  entry: RuntimeEntry,
  options: { uninstall?: boolean } = {}
): PlannedWrite[] {
  const targets = def.targets(ctx);
  if (!targets.length) {
    throw new ConnectError('UNSUPPORTED', `${def.label} has no writable config (use --print)`);
  }
  return targets.map((target) => planTarget(def, target, entry, Boolean(options.uninstall)));
}

export interface AppliedWrite extends PlannedWrite {
  written: boolean;
}

/** Plan a JSON settings file transformation (used for hook entries). */
export function planJsonTransform(
  path: string,
  transform: (current: Record<string, unknown>) => Record<string, unknown>
): PlannedWrite {
  const file = readJson(path);
  const next = transform(file.value);
  const content = renderJson(next, detectIndent(file.text));
  if (file.exists && content === file.text) {
    return { agentId: '', path, format: 'json', action: 'unchanged', content };
  }
  return {
    agentId: '',
    path,
    format: 'json',
    action: file.exists ? 'update' : 'create',
    content,
    backup: file.exists ? file.text : undefined,
  };
}

/** Apply planned writes. Dry-run returns the plan with `written: false`. */
export function applyPlannedWrites(plans: PlannedWrite[], options: { dryRun?: boolean } = {}): AppliedWrite[] {
  return plans.map((plan) => {
    if (plan.action === 'unchanged' || plan.action === 'absent') {
      return { ...plan, written: false };
    }
    if (options.dryRun) return { ...plan, written: false };

    mkdirSync(dirname(plan.path), { recursive: true });
    if (plan.backup !== undefined) {
      const backupPath = `${plan.path}.nexus-backup`;
      writeFileSync(backupPath, plan.backup, { encoding: 'utf8', mode: 0o600 });
    }
    writeFileSync(plan.path, plan.content, { encoding: 'utf8', mode: 0o600 });
    try {
      chmodSync(plan.path, 0o600);
    } catch {
      // Best effort (Windows ignores POSIX modes).
    }
    return { ...plan, written: true };
  });
}

/** True when the agent's config already contains a nexus entry. */
export function isAgentConnected(def: AgentDefinition, ctx: AgentContext): boolean {
  return def.targets(ctx).some((target) => {
    if (!existsSync(target.path)) return false;
    const text = readFileSync(target.path, 'utf8');
    if (target.format === 'toml') {
      return BLOCK_RE.test(text) || /^\[mcp_servers\.nexus\]/m.test(text);
    }
    try {
      const value = JSON.parse(text) as Record<string, unknown>;
      const section = getIn(value, targetKey(target.kind, value));
      return Boolean(section && typeof section === 'object' && 'nexus' in (section as object));
    } catch {
      return false;
    }
  });
}

/** Read the API key already embedded for this agent, so re-runs do not mint new keys. */
export function existingApiKey(def: AgentDefinition, ctx: AgentContext): string | null {
  for (const target of def.targets(ctx)) {
    if (!existsSync(target.path)) continue;
    const text = readFileSync(target.path, 'utf8');
    if (target.format === 'toml') {
      const match = text.match(/http_headers\s*=\s*\{[^}]*Bearer\s+([A-Za-z0-9_-]+)/);
      if (match?.[1]) return match[1];
      continue;
    }
    try {
      const value = JSON.parse(text) as Record<string, unknown>;
      const section = getIn(value, targetKey(target.kind, value)) as Record<string, unknown> | undefined;
      const entry = section?.nexus as Record<string, unknown> | undefined;
      const headers = entry?.headers as Record<string, string> | undefined;
      const auth = headers?.Authorization ?? headers?.authorization;
      const fromHeader = auth?.replace(/^Bearer\s+/i, '');
      if (fromHeader) return fromHeader;
      const env = entry?.env as Record<string, string> | undefined;
      if (env?.NEXUS_API_KEY) return env.NEXUS_API_KEY;
      const environment = entry?.environment as Record<string, string> | undefined;
      if (environment?.NEXUS_API_KEY) return environment.NEXUS_API_KEY;
    } catch {
      // An unreadable config is reported by planAgentConnect; skip here.
    }
  }
  return null;
}

export function stdioEntryCommand(scriptPath: string): RuntimeEntry['stdio'] {
  return { command: process.execPath, args: [scriptPath, 'mcp-stdio'], env: {} };
}

export function detectedAgents(defs: AgentDefinition[], ctx: AgentContext): AgentDefinition[] {
  return defs.filter((def) => def.detectPaths(ctx).some((path) => existsSync(path)));
}
