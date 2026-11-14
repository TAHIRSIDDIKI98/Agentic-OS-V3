/**
 * connectors/agent-registry.ts — where each coding agent keeps its MCP config.
 *
 * Data only: the connect engine (agent-connect.ts) does the reading/writing.
 * Every path is derived from an injected home directory so tests never touch the
 * real user profile, and each entry records the exact section key the agent
 * expects (they are NOT interchangeable — see the note on each).
 *
 * Verified against vendor docs as of this change:
 *   Codex       ~/.codex/config.toml  [mcp_servers.<id>] url / http_headers
 *   OpenCode    ~/.config/opencode/opencode.json  mcp.<id> { type: "remote" }
 *   Claude Code ~/.claude.json  mcpServers.<id>   + settings.json hooks
 * Agents marked with a caveat are configured with a best-known shape; the CLI
 * prints the caveat so the user can verify.
 */
import { join as joinPath } from 'node:path';
import type { Scope } from '../lib/security.js';

export type AgentId =
  | 'claude-code'
  | 'cursor'
  | 'cline'
  | 'codex'
  | 'gemini'
  | 'windsurf'
  | 'vscode'
  | 'opencode'
  | 'kiro'
  | 'openclaw'
  | 'hermes'
  | 'generic';

export interface AgentContext {
  /** Injected home directory (tests pass a temp dir). */
  home: string;
  /** Project directory, for project-scoped configs. */
  cwd: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
}

/** How the agent's config file is structured. */
export type ConfigKind = 'mcpServers' | 'vscodeServers' | 'opencodeMcp' | 'codexToml' | 'projectMcp';

export interface AgentTarget {
  path: string;
  format: 'json' | 'toml';
  kind: ConfigKind;
}

export interface AgentDefinition {
  id: AgentId;
  label: string;
  /** Least-privilege scopes minted for this agent's dedicated key. */
  scopes: Scope[];
  /** Paths whose existence suggests the agent is installed. */
  detectPaths: (ctx: AgentContext) => string[];
  /** Files this connector manages. */
  targets: (ctx: AgentContext) => AgentTarget[];
  /** Write Claude Code hook entries alongside the MCP server. */
  hooks?: 'claude-code';
  /** Printed to the user when the config shape is best-known rather than documented. */
  caveat?: string;
}

const DEFAULT_SCOPES: Scope[] = ['memory:read', 'memory:write', 'skill:read'];

/** VS Code stores MCP servers in a `servers` key, not `mcpServers`. */
function vscodeUserConfig(ctx: AgentContext): string {
  if (ctx.platform === 'win32') {
    const appData = ctx.env.APPDATA ?? joinPath(ctx.home, 'AppData', 'Roaming');
    return joinPath(appData, 'Code', 'User', 'mcp.json');
  }
  if (ctx.platform === 'darwin') {
    return joinPath(ctx.home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json');
  }
  return joinPath(ctx.home, '.config', 'Code', 'User', 'mcp.json');
}

export const AGENTS: AgentDefinition[] = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    scopes: ['memory:read', 'memory:write', 'skill:read'],
    detectPaths: (ctx) => [joinPath(ctx.home, '.claude'), joinPath(ctx.home, '.claude.json')],
    // User-scope MCP servers live in ~/.claude.json; ~/.claude/settings.json is
    // for hooks, which are written separately (see hooks integration).
    targets: (ctx) => [
      { path: joinPath(ctx.home, '.claude.json'), format: 'json', kind: 'mcpServers' },
    ],
    hooks: 'claude-code',
  },
  {
    id: 'cursor',
    label: 'Cursor',
    scopes: DEFAULT_SCOPES,
    detectPaths: (ctx) => [joinPath(ctx.home, '.cursor'), joinPath(ctx.home, '.cursor', 'mcp.json')],
    targets: (ctx) => [
      { path: joinPath(ctx.home, '.cursor', 'mcp.json'), format: 'json', kind: 'mcpServers' },
    ],
  },
  {
    id: 'cline',
    label: 'Cline',
    scopes: DEFAULT_SCOPES,
    detectPaths: (ctx) => [joinPath(ctx.home, '.cline'), joinPath(ctx.home, 'Documents', 'Cline')],
    targets: (ctx) => [
      { path: joinPath(ctx.home, '.cline', 'mcp_settings.json'), format: 'json', kind: 'mcpServers' },
    ],
    caveat: 'Cline stores settings inside VS Code extension storage in some versions; verify ~/.cline/mcp_settings.json is read by your build.',
  },
  {
    id: 'codex',
    label: 'Codex CLI',
    scopes: DEFAULT_SCOPES,
    detectPaths: (ctx) => [joinPath(ctx.home, '.codex'), joinPath(ctx.home, '.codex', 'config.toml')],
    targets: (ctx) => [
      { path: joinPath(ctx.home, '.codex', 'config.toml'), format: 'toml', kind: 'codexToml' },
    ],
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    scopes: DEFAULT_SCOPES,
    detectPaths: (ctx) => [joinPath(ctx.home, '.gemini'), joinPath(ctx.home, '.gemini', 'settings.json')],
    targets: (ctx) => [
      { path: joinPath(ctx.home, '.gemini', 'settings.json'), format: 'json', kind: 'mcpServers' },
    ],
  },
  {
    id: 'windsurf',
    label: 'Windsurf',
    scopes: DEFAULT_SCOPES,
    detectPaths: (ctx) => [
      joinPath(ctx.home, '.codeium', 'windsurf'),
      joinPath(ctx.home, '.windsurf'),
    ],
    targets: (ctx) => [
      {
        path: joinPath(ctx.home, '.codeium', 'windsurf', 'mcp_config.json'),
        format: 'json',
        kind: 'mcpServers',
      },
    ],
  },
  {
    id: 'vscode',
    label: 'VS Code / Copilot',
    scopes: DEFAULT_SCOPES,
    detectPaths: (ctx) => [vscodeUserConfig(ctx)],
    targets: (ctx) => [{ path: vscodeUserConfig(ctx), format: 'json', kind: 'vscodeServers' }],
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    scopes: DEFAULT_SCOPES,
    detectPaths: (ctx) => [
      joinPath(ctx.home, '.config', 'opencode'),
      joinPath(ctx.home, '.opencode'),
    ],
    targets: (ctx) => [
      {
        path: joinPath(ctx.home, '.config', 'opencode', 'opencode.json'),
        format: 'json',
        kind: 'opencodeMcp',
      },
    ],
    caveat: 'OpenCode 2 nests servers under mcp.servers; this connector adapts to the shape already present in the file.',
  },
  {
    id: 'kiro',
    label: 'Kiro',
    scopes: DEFAULT_SCOPES,
    detectPaths: (ctx) => [joinPath(ctx.home, '.kiro')],
    targets: (ctx) => [
      { path: joinPath(ctx.home, '.kiro', 'settings', 'mcp.json'), format: 'json', kind: 'mcpServers' },
    ],
    caveat: 'Kiro config location varies by build; verify ~/.kiro/settings/mcp.json.',
  },
  {
    id: 'openclaw',
    label: 'OpenClaw',
    scopes: DEFAULT_SCOPES,
    detectPaths: (ctx) => [joinPath(ctx.home, '.openclaw')],
    targets: (ctx) => [
      { path: joinPath(ctx.home, '.openclaw', 'config.json'), format: 'json', kind: 'mcpServers' },
    ],
    caveat: 'OpenClaw config shape is best-known; verify the generated entry against your version.',
  },
  {
    id: 'hermes',
    label: 'Hermes',
    scopes: ['memory:read', 'memory:write', 'skill:read', 'skill:write', 'audit:read'],
    detectPaths: (ctx) => [joinPath(ctx.cwd, '.mcp.json'), joinPath(ctx.home, '.hermes')],
    targets: (ctx) => [{ path: joinPath(ctx.cwd, '.mcp.json'), format: 'json', kind: 'projectMcp' }],
  },
  {
    id: 'generic',
    label: 'Generic MCP client',
    scopes: DEFAULT_SCOPES,
    detectPaths: () => [],
    targets: () => [],
    caveat: 'Prints a portable config snippet instead of writing a file.',
  },
];

export function findAgent(id: string): AgentDefinition | undefined {
  return AGENTS.find((agent) => agent.id === id);
}

export function agentIds(): AgentId[] {
  return AGENTS.map((agent) => agent.id);
}
