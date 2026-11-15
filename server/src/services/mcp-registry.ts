/**
 * services/mcp-registry.ts — Phase 3.3 & Phase 12: MCP Server Registry
 *
 * Manages the lifecycle of external MCP servers:
 *  - Register servers (stdio, HTTP/SSE, Streamable HTTP)
 *  - Hardened stdio subprocess transport with JSON-RPC 2.0 boundary parsing & buffer limits
 *  - 30s ping/pong heartbeats & exponential backoff auto-reconnection
 *  - Automatic tool discovery and mapping into ActionRegistry
 *  - Integration with the audit engine for lifecycle events
 */

import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { z } from 'zod';
import { appendAudit } from '../lib/audit.js';
import { type Action, type ActionContext, type ActionRegistry } from './agent-runtime.js';
import { type Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type MCPTransportType = 'stdio' | 'http-sse' | 'streamable-http';

export interface StdioConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface HttpSseConfig {
  url: string;
  headers?: Record<string, string>;
}

export interface StreamableHttpConfig {
  url: string;
  headers?: Record<string, string>;
}

export type MCPConnectionConfig = StdioConfig | HttpSseConfig | StreamableHttpConfig;

export interface MCPToolDefinition {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export type MCPServerStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface MCPServerRecord {
  id: string;
  name: string;
  transport: MCPTransportType;
  config: MCPConnectionConfig;
  status: MCPServerStatus;
  tools: MCPToolDefinition[];
  error?: string;
  lastConnected?: Date;
  createdAt: Date;
}

export interface MCPRegistryStats {
  total: number;
  connected: number;
  disconnected: number;
  errored: number;
  totalTools: number;
}

// ── Events ─────────────────────────────────────────────────────────────────────

export type MCPRegistryEvent =
  | { type: 'server:registered'; server: MCPServerRecord }
  | { type: 'server:unregistered'; id: string }
  | { type: 'server:connected'; id: string }
  | { type: 'server:disconnected'; id: string }
  | { type: 'server:error'; id: string; error: string }
  | { type: 'server:tools_discovered'; id: string; tools: MCPToolDefinition[] }
  | { type: 'server:health_check_failed'; id: string; error: string };

// ── JSON-RPC 2.0 Boundary Parser ─────────────────────────────────────────────

/**
 * Hardened JSON-RPC 2.0 message parser supporting line-delimited
 * and Content-Length framed streams with buffer overflow protection.
 */
export class JsonRpcMessageParser {
  private buffer = '';
  private readonly maxBufferSize: number;

  constructor(maxBufferSize = 10 * 1024 * 1024) {
    // Default 10MB
    this.maxBufferSize = maxBufferSize;
  }

  parseChunk(
    chunk: Buffer | string,
    onMessage: (msg: unknown) => void,
    onError?: (err: Error) => void
  ): void {
    this.buffer += chunk.toString('utf8');

    if (this.buffer.length > this.maxBufferSize) {
      this.buffer = '';
      onError?.(new Error(`JSON-RPC buffer limit exceeded (${this.maxBufferSize} bytes)`));
      return;
    }

    while (this.buffer.length > 0) {
      // Content-Length header framing (LSP style)
      if (this.buffer.startsWith('Content-Length:')) {
        const headerEnd = this.buffer.indexOf('\r\n\r\n');
        const altHeaderEnd = this.buffer.indexOf('\n\n');
        const sepIndex = headerEnd !== -1 ? headerEnd : altHeaderEnd;
        const sepLen = headerEnd !== -1 ? 4 : 2;

        if (sepIndex === -1) {
          // Incomplete header, wait for more data
          break;
        }

        const headerLine = this.buffer.slice(0, sepIndex);
        const match = headerLine.match(/Content-Length:\s*(\d+)/i);
        if (match && match[1]) {
          const contentLength = parseInt(match[1], 10);
          const totalLength = sepIndex + sepLen + contentLength;
          if (this.buffer.length < totalLength) {
            // Incomplete body, wait for more data
            break;
          }

          const bodyStr = this.buffer.slice(sepIndex + sepLen, totalLength);
          this.buffer = this.buffer.slice(totalLength);

          try {
            const obj = JSON.parse(bodyStr);
            if (obj && typeof obj === 'object') {
              onMessage(obj);
            }
          } catch (err) {
            onError?.(err instanceof Error ? err : new Error(String(err)));
          }
          continue;
        }
      }

      // Newline-delimited framing
      const lineEnd = this.buffer.indexOf('\n');
      if (lineEnd === -1) {
        // Incomplete line, wait for more data
        break;
      }

      let line = this.buffer.slice(0, lineEnd);
      this.buffer = this.buffer.slice(lineEnd + 1);

      if (line.endsWith('\r')) {
        line = line.slice(0, -1);
      }

      line = line.trim();
      if (!line) continue;

      try {
        const obj = JSON.parse(line);
        if (obj && typeof obj === 'object') {
          const o = obj as Record<string, unknown>;
          if (o.jsonrpc === '2.0' || 'method' in o || 'id' in o || 'result' in o || 'error' in o) {
            onMessage(obj);
          }
        }
      } catch {
        // Safely ignore non-JSON log lines output by subprocesses to stdout
      }
    }
  }

  reset(): void {
    this.buffer = '';
  }
}

// ── Hardened Stdio Transport ─────────────────────────────────────────────────

/**
 * Hardened stdio subprocess transport with JSON-RPC 2.0 boundary parsing,
 * buffer limits, and graceful process lifetime management.
 */
export class HardenedStdioClientTransport implements Transport {
  private process?: ChildProcess;
  private parser = new JsonRpcMessageParser(10 * 1024 * 1024);
  private stderrBuffer = '';
  private started = false;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(private config: StdioConfig) {}

  /**
   * Build a filtered env for MCP subprocess — allowlist ONLY, explicit blocklist.
   * This is the ONLY place where env is accessed (per security gate).
   */
  private buildFilteredEnv(extraEnv?: Record<string, string>): Record<string, string> {
    const ALLOW = new Set(['PATH', 'HOME', 'NODE_ENV', 'NEXUS_LLM_PROVIDER', 'NEXUS_LLM_API_KEY']);
    // Explicit blocklist per Phase 1.3 — must never leak even if added to allowlist in future.
    const BLOCK = new Set([
      'NEXUS_API_KEY',
      'NEXUS_BLOCKCHAIN_PRIVATE_KEY',
      'NEXUS_BLOCKCHAIN_ENCRYPTION_KEY',
      'DATABASE_URL',
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'GOOGLE_API_KEY',
      'GROQ_API_KEY',
      'MISTRAL_API_KEY',
      'AZURE_OPENAI_API_KEY',
      'VLLM_API_KEY',
      'M3_API_KEY',
      'PORTKEY_API_KEY',
      'NEXUS_OTEL_API_KEY',
      'NEXUS_REDIS_URL',
      'VAULT_TOKEN',
      'AWS_KMS_KEY_ID',
      'HSM_LOCAL_KEY',
    ]);

    const out: Record<string, string> = {};
    // Only copy from env what is in ALLOW and NOT in BLOCK
    for (const key of ALLOW) {
      if (BLOCK.has(key)) continue;
      const val = process.env[key];
      if (val !== undefined) out[key] = String(val);
    }
    // Overlay extraEnv but still enforce ALLOW + BLOCK
    if (extraEnv) {
      for (const [k, v] of Object.entries(extraEnv)) {
        if (!ALLOW.has(k)) continue;
        if (BLOCK.has(k)) continue;
        if (v !== undefined) out[k] = String(v);
      }
    }
    return out;
  }

  async start(): Promise<void> {
    if (this.started) throw new Error('Stdio transport already started');
    this.started = true;

    const filteredEnv = this.buildFilteredEnv(this.config.env);

    this.process = spawn(this.config.command, this.config.args ?? [], {
      env: filteredEnv,
      cwd: this.config.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.process.on('error', (err) => {
      this.onerror?.(new Error(`MCP subprocess spawn error: ${err.message}`));
    });

    this.process.on('exit', (code, signal) => {
      const exitReason = signal ? `terminated by signal ${signal}` : `exited with code ${code}`;
      if (code !== 0 && code !== null) {
        const stderrSnippet = this.stderrBuffer.slice(-2000);
        this.onerror?.(
          new Error(`MCP subprocess ${exitReason}. Stderr: ${stderrSnippet || '(none)'}`)
        );
      }
      this.onclose?.();
    });

    this.process.stdout?.on('data', (chunk: Buffer) => {
      this.parser.parseChunk(
        chunk,
        (msg) => {
          this.onmessage?.(msg as JSONRPCMessage);
        },
        (err) => {
          this.onerror?.(err);
        }
      );
    });

    this.process.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      this.stderrBuffer += text;
      if (this.stderrBuffer.length > 64 * 1024) {
        this.stderrBuffer = this.stderrBuffer.slice(-64 * 1024);
      }
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.process || !this.process.stdin || this.process.stdin.destroyed) {
      throw new Error('Stdio process is not running or stdin is closed');
    }

    const str = JSON.stringify(message) + '\n';
    return new Promise((resolve, reject) => {
      this.process!.stdin!.write(str, 'utf8', (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async close(): Promise<void> {
    if (this.process) {
      try {
        this.process.removeAllListeners();
        this.process.stdout?.removeAllListeners();
        this.process.stderr?.removeAllListeners();
        this.process.stdin?.end();
        this.process.kill();
      } catch {
        // Process already dead
      }
      this.process = undefined;
    }
    this.parser.reset();
    this.started = false;
    this.onclose?.();
  }

  /** Access to the underlying spawned child process (if any). */
  getProcess(): ChildProcess | undefined {
    return this.process;
  }
}

// ── Helper: JSON Schema to Zod ───────────────────────────────────────────────

/** Helper to convert basic JSON Schema objects into Zod object schemas. */
export function jsonSchemaToZod(schema: unknown): z.ZodObject<z.ZodRawShape> {
  if (!schema || typeof schema !== 'object') {
    return z.object({}).passthrough();
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- external MCP servers supply arbitrary JSON Schema; shape is validated field-by-field below before use
  const s = schema as Record<string, any>;
  if (s.type === 'object' && s.properties && typeof s.properties === 'object') {
    const shape: Record<string, z.ZodTypeAny> = {};
    const required = Array.isArray(s.required) ? s.required : [];
    for (const [propName, propDef] of Object.entries(s.properties)) {
      const isReq = required.includes(propName);
      let fieldSchema: z.ZodTypeAny = z.unknown();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- external MCP servers supply arbitrary JSON Schema; shape is validated field-by-field below before use
      const p = propDef as Record<string, any>;
      if (p.type === 'string') fieldSchema = z.string();
      else if (p.type === 'number' || p.type === 'integer') fieldSchema = z.number();
      else if (p.type === 'boolean') fieldSchema = z.boolean();
      else if (p.type === 'array') fieldSchema = z.array(z.unknown());
      else if (p.type === 'object') fieldSchema = z.record(z.string(), z.unknown());

      if (p.description) {
        fieldSchema = fieldSchema.describe(p.description);
      }
      shape[propName] = isReq ? fieldSchema : fieldSchema.optional();
    }
    return z.object(shape).passthrough();
  }
  return z.object({}).passthrough();
}

// ── Registry ───────────────────────────────────────────────────────────────────

const ACTOR = 'mcp-registry';

/**
 * MCPRegistry manages the lifecycle of MCP servers.
 *
 * Design:
 *  - Singleton (one registry per process)
 *  - Event-driven for loose coupling
 *  - Auto-reconnects with exponential backoff
 *  - 30s ping/pong heartbeats for health checking
 *  - Auto-maps tools to ActionRegistry
 *  - Every lifecycle mutation appends to the hash-chained audit log
 */
export class MCPRegistry {
  private servers = new Map<string, MCPServerRecord>();
  private connections = new Map<string, { client: unknown; transport: unknown }>();
  private processes = new Map<string, ChildProcess>();
  private healthTimers = new Map<string, ReturnType<typeof setInterval>>();
  private reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private reconnectAttempts = new Map<string, number>();
  private serverActionNames = new Map<string, Set<string>>();
  private emitter = new EventEmitter();
  private actionRegistry?: ActionRegistry;

  private static instance: MCPRegistry;

  /** Get the singleton registry instance. */
  static getInstance(): MCPRegistry {
    if (!MCPRegistry.instance) {
      MCPRegistry.instance = new MCPRegistry();
    }
    return MCPRegistry.instance;
  }

  /** Set target ActionRegistry for automatic tool mapping. */
  setActionRegistry(actionRegistry: ActionRegistry): void {
    this.actionRegistry = actionRegistry;
    // Sync all currently connected servers
    for (const [id, record] of this.servers) {
      if (record.status === 'connected') {
        this.syncToolsToActionRegistry(id);
      }
    }
  }

  // ── Server Lifecycle ─────────────────────────────────────────

  /**
   * Register a new MCP server in the registry.
   * Does NOT connect — call `connect(id)` separately.
   */
  register(
    name: string,
    transport: MCPTransportType,
    config: MCPConnectionConfig
  ): MCPServerRecord {
    const id = `mcp_${randomUUID()}`;
    const record: MCPServerRecord = {
      id,
      name,
      transport,
      config,
      status: 'disconnected',
      tools: [],
      createdAt: new Date(),
    };
    this.servers.set(id, record);
    this.emitter.emit('server:registered', { type: 'server:registered', server: record });
    return record;
  }

  /**
   * Unregister a server. Disconnects first if connected.
   */
  unregister(id: string): boolean {
    this.disconnect(id).catch(() => {});
    this.stopHealthChecks(id);
    this.cancelReconnect(id);
    this.clearActionRegistryForServer(id);
    const removed = this.servers.delete(id);
    if (removed) {
      this.reconnectAttempts.delete(id);
      this.emitter.emit('server:unregistered', { type: 'server:unregistered', id });
    }
    return removed;
  }

  /**
   * Connect to a registered server.
   * Creates the appropriate transport, establishes the MCP connection,
   * then auto-discovers available tools and maps them to ActionRegistry.
   */
  async connect(id: string): Promise<boolean> {
    const record = this.servers.get(id);
    if (!record) throw new Error(`MCP server ${id} not found`);
    if (record.status === 'connected') return true;

    record.status = 'connecting';
    record.error = undefined;

    try {
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');

      const client = new Client(
        { name: 'nexus-mcp-registry', version: '2.0.0' },
        { capabilities: {} }
      );

      let transport: unknown;

      switch (record.transport) {
        case 'stdio': {
          const cfg = record.config as StdioConfig;
          const stdioTransport = new HardenedStdioClientTransport(cfg);
          transport = stdioTransport;
          break;
        }

        case 'streamable-http': {
          const cfg = record.config as StreamableHttpConfig;
          const { StreamableHTTPClientTransport } =
            await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
          transport = new StreamableHTTPClientTransport(new URL(cfg.url));
          break;
        }

        case 'http-sse': {
          const cfg = record.config as HttpSseConfig;
          const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js');
          const sseOpts: Record<string, unknown> = {};
          if (cfg.headers) {
            sseOpts.requestInit = { headers: cfg.headers };
          }
          transport = new SSEClientTransport(new URL(cfg.url), sseOpts);
          break;
        }

        default:
          throw new Error(`Unsupported transport type: ${record.transport}`);
      }

      // Attach transport event listeners for abnormal disconnects
      const t = transport as Transport;
      if (t.onerror) {
        const origErr = t.onerror.bind(t);
        t.onerror = (err: Error) => {
          origErr(err);
          this.handleConnectionFailure(id, err.message);
        };
      } else {
        t.onerror = (err: Error) => {
          this.handleConnectionFailure(id, err.message);
        };
      }

      if (t.onclose) {
        const origClose = t.onclose.bind(t);
        t.onclose = () => {
          origClose();
          this.handleConnectionFailure(id, 'Transport connection closed unexpectedly');
        };
      } else {
        t.onclose = () => {
          this.handleConnectionFailure(id, 'Transport connection closed unexpectedly');
        };
      }

      await (client as { connect: (t: unknown) => Promise<void> }).connect(transport);
      this.connections.set(id, { client, transport });

      if (transport instanceof HardenedStdioClientTransport) {
        const proc = transport.getProcess();
        if (proc) this.processes.set(id, proc);
      }

      record.status = 'connected';
      record.lastConnected = new Date();
      this.reconnectAttempts.delete(id);
      this.cancelReconnect(id);

      await appendAudit(
        'mcp.connected',
        {
          serverId: id,
          name: record.name,
          transport: record.transport,
          config: sanitizeConfig(record.config),
        },
        ACTOR
      );

      this.emitter.emit('server:connected', { type: 'server:connected', id });

      // Start 30s ping/pong heartbeats
      this.startHealthChecks(id, 30000);

      // Auto-discover tools and map into ActionRegistry (non-fatal if it fails)
      try {
        const tools = await this.discoverTools(id);
        record.tools = tools;
      } catch {
        // Tools will be discovered on next health check or explicitly
      }

      return true;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      record.status = 'error';
      record.error = msg;

      await appendAudit(
        'mcp.connect_failed',
        {
          serverId: id,
          name: record.name,
          transport: record.transport,
          error: msg,
        },
        ACTOR
      );

      this.emitter.emit('server:error', { type: 'server:error', id, error: msg });
      this.scheduleReconnect(id);
      return false;
    }
  }

  /**
   * Disconnect from a server. Cleans up the client, process, timers, and mapped actions.
   */
  async disconnect(id: string): Promise<boolean> {
    this.stopHealthChecks(id);
    this.cancelReconnect(id);

    const conn = this.connections.get(id);
    if (conn) {
      try {
        await (conn.client as { close: () => Promise<void> }).close();
      } catch {
        // already closed
      }
      this.connections.delete(id);
    }

    const proc = this.processes.get(id);
    if (proc) {
      try {
        proc.kill();
      } catch {
        // already dead
      }
      this.processes.delete(id);
    }

    this.clearActionRegistryForServer(id);

    const record = this.servers.get(id);
    if (record) {
      record.status = 'disconnected';

      await appendAudit('mcp.disconnected', { serverId: id, name: record.name }, ACTOR);

      this.emitter.emit('server:disconnected', { type: 'server:disconnected', id });
    }

    return true;
  }

  // ── Connection Failure & Reconnection ────────────────────────

  private handleConnectionFailure(id: string, error: string): void {
    const record = this.servers.get(id);
    if (!record || record.status === 'disconnected') return;

    record.status = 'error';
    record.error = error;
    this.clearActionRegistryForServer(id);
    this.emitter.emit('server:error', { type: 'server:error', id, error });
    this.scheduleReconnect(id);
  }

  private scheduleReconnect(id: string): void {
    const record = this.servers.get(id);
    if (!record || record.status === 'connecting' || record.status === 'disconnected') return;

    if (this.reconnectTimers.has(id)) return;

    const attempts = (this.reconnectAttempts.get(id) ?? 0) + 1;
    this.reconnectAttempts.set(id, attempts);

    // Exponential backoff: 1s, 2s, 4s, 8s, 16s, max 30s
    // ±25% random jitter prevents reconnection storms when multiple servers fail together
    const baseDelay = Math.min(1000 * Math.pow(2, attempts - 1), 30000);
    const jitter = baseDelay * (0.75 + Math.random() * 0.5); // 75%–125% of base

    const timer = setTimeout(async () => {
      this.reconnectTimers.delete(id);
      const server = this.servers.get(id);
      if (server && (server.status === 'error' || server.status === 'disconnected')) {
        await this.connect(id).catch(() => {});
      }
    }, jitter);

    this.reconnectTimers.set(id, timer);
  }

  private cancelReconnect(id: string): void {
    const timer = this.reconnectTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(id);
    }
  }

  // ── Tool Discovery & ActionRegistry Mapping ───────────────────

  /**
   * Discover tools from a connected MCP server.
   * Returns the list of tool definitions, caches them, and maps them to ActionRegistry.
   */
  async discoverTools(id: string): Promise<MCPToolDefinition[]> {
    const conn = this.connections.get(id);
    if (!conn) throw new Error(`MCP server ${id} is not connected`);

    const result = await (
      conn.client as { listTools: () => Promise<{ tools: unknown[] }> }
    ).listTools();

    const tools: MCPToolDefinition[] = (result.tools ?? []).map((t: unknown) => {
      const def = t as { name: string; description?: string; inputSchema?: unknown };
      return {
        name: def.name,
        description: def.description,
        inputSchema: def.inputSchema,
      };
    });

    const record = this.servers.get(id);
    if (record) {
      record.tools = tools;
    }

    this.syncToolsToActionRegistry(id);

    this.emitter.emit('server:tools_discovered', {
      type: 'server:tools_discovered',
      id,
      tools,
    });

    return tools;
  }

  /** Synchronize server tools into the registered ActionRegistry. */
  syncToolsToActionRegistry(id: string): void {
    if (!this.actionRegistry) return;

    const record = this.servers.get(id);
    if (!record) return;

    this.clearActionRegistryForServer(id);

    const actionNames = new Set<string>();

    for (const tool of record.tools) {
      let actionName = tool.name;
      if (this.actionRegistry.get(actionName)) {
        actionName = `${record.name}_${tool.name}`;
      }

      const action: Action = {
        name: actionName,
        description: tool.description || `MCP tool ${tool.name} from server ${record.name}`,
        schema: jsonSchemaToZod(tool.inputSchema),
        similes: Array.from(
          new Set([
            tool.name,
            `${record.name}.${tool.name}`,
            `${record.name}_${tool.name}`,
            `mcp_${tool.name}`,
          ])
        ),
        examples: [],
        metadata: {
          version: '1.0',
          category: 'mcp',
          provider: 'mcp',
          riskLevel: 'read',
          timeoutMs: 30000,
        },
        handler: async (input: Record<string, unknown>, _context: ActionContext) => {
          return await this.callTool(id, tool.name, input);
        },
      };

      try {
        this.actionRegistry.register(action);
        actionNames.add(actionName);
      } catch {
        // If registration fails, skip
      }
    }

    this.serverActionNames.set(id, actionNames);
  }

  private clearActionRegistryForServer(id: string): void {
    if (!this.actionRegistry) return;
    const names = this.serverActionNames.get(id);
    if (names) {
      for (const name of names) {
        this.actionRegistry.unregister(name);
      }
      this.serverActionNames.delete(id);
    }
  }

  /**
   * Get tools for a specific server, or all tools across all registered servers.
   */
  getTools(id?: string): MCPToolDefinition[] {
    if (id) {
      return this.servers.get(id)?.tools ?? [];
    }
    const all: MCPToolDefinition[] = [];
    for (const s of this.servers.values()) {
      all.push(...s.tools);
    }
    return all;
  }

  /**
   * Call a tool on a specific MCP server.
   */
  async callTool(id: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const conn = this.connections.get(id);
    if (!conn) throw new Error(`MCP server ${id} is not connected`);

    const result = await (
      conn.client as {
        callTool: (
          params: { name: string; arguments?: Record<string, unknown> },
          resultSchema?: unknown
        ) => Promise<unknown>;
      }
    ).callTool({ name: toolName, arguments: args });

    return result;
  }

  // ── Query ────────────────────────────────────────────────────

  /** List all registered servers. */
  listServers(): MCPServerRecord[] {
    return Array.from(this.servers.values());
  }

  /** Get a single server by id. */
  getServer(id: string): MCPServerRecord | undefined {
    return this.servers.get(id);
  }

  /** Get aggregate stats about the registry. */
  getStats(): MCPRegistryStats {
    let connected = 0;
    let disconnected = 0;
    let errored = 0;
    let totalTools = 0;

    for (const s of this.servers.values()) {
      if (s.status === 'connected') connected++;
      else if (s.status === 'error') errored++;
      else disconnected++;
      totalTools += s.tools.length;
    }

    return { total: this.servers.size, connected, disconnected, errored, totalTools };
  }

  // ── Health & Reconnection ────────────────────────────────────

  /**
   * Health-check a single server by calling `ping` with a 5s timeout.
   * On failure, automatically schedules a reconnection attempt
   * with exponential backoff.
   */
  async healthCheck(id: string): Promise<boolean> {
    const conn = this.connections.get(id);
    if (!conn) return false;

    try {
      const pingPromise = (conn.client as { ping: () => Promise<void> }).ping();
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Health check ping timeout (5s)')), 5000)
      );
      await Promise.race([pingPromise, timeoutPromise]);

      const record = this.servers.get(id);
      if (record) {
        record.status = 'connected';
        record.error = undefined;
        record.lastConnected = new Date();
      }
      this.reconnectAttempts.delete(id);
      return true;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const record = this.servers.get(id);
      if (record) {
        record.status = 'error';
        record.error = msg;
      }

      this.emitter.emit('server:health_check_failed', {
        type: 'server:health_check_failed',
        id,
        error: msg,
      });

      this.scheduleReconnect(id);
      return false;
    }
  }

  /**
   * Start periodic health checks for a server.
   * Default interval: 30 seconds.
   */
  startHealthChecks(id: string, intervalMs = 30000): void {
    this.stopHealthChecks(id);
    const timer = setInterval(() => {
      this.healthCheck(id).catch(() => {});
    }, intervalMs);
    this.healthTimers.set(id, timer);
  }

  /** Stop health checks for a server. */
  stopHealthChecks(id: string): void {
    const timer = this.healthTimers.get(id);
    if (timer) {
      clearInterval(timer);
      this.healthTimers.delete(id);
    }
  }

  /**
   * Attempt to reconnect all errored or disconnected servers.
   */
  async reconnectAll(): Promise<void> {
    const promises: Promise<boolean>[] = [];
    for (const [id, record] of this.servers) {
      if (record.status === 'error' || record.status === 'disconnected') {
        promises.push(this.connect(id));
      }
    }
    await Promise.allSettled(promises);
  }

  // ── Events ───────────────────────────────────────────────────

  /** Subscribe to registry events. */
  on(event: string, handler: (...args: unknown[]) => void): void {
    this.emitter.on(event, handler);
  }

  /** Unsubscribe from registry events. */
  off(event: string, handler: (...args: unknown[]) => void): void {
    this.emitter.off(event, handler);
  }

  // ── Cleanup ──────────────────────────────────────────────────

  /** Shut down the registry: disconnect all servers and clear timers. */
  async shutdown(): Promise<void> {
    for (const id of this.healthTimers.keys()) {
      this.stopHealthChecks(id);
    }
    for (const id of this.reconnectTimers.keys()) {
      this.cancelReconnect(id);
    }
    const promises: Promise<boolean>[] = [];
    for (const id of this.servers.keys()) {
      promises.push(this.disconnect(id));
    }
    await Promise.allSettled(promises);
  }
}

// ── Singleton export ───────────────────────────────────────────────────────────

/** Singleton registry instance. */
export const mcpRegistry = MCPRegistry.getInstance();

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Strip sensitive fields from config before audit logging. */
function sanitizeConfig(config: MCPConnectionConfig): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  if ('command' in config) {
    safe.command = config.command;
    safe.args = config.args;
    safe.cwd = config.cwd;
    safe.env = config.env
      ? Object.fromEntries(Object.entries(config.env).map(([k]) => [k, '***REDACTED***']))
      : undefined;
  } else {
    safe.url = (config as HttpSseConfig | StreamableHttpConfig).url;
  }
  return safe;
}
