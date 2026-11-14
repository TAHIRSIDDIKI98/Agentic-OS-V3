/**
 * connectors/agent-hooks.ts — automatic recall/capture hooks for coding agents.
 *
 * Why this exists: an agent only uses NEXUS if it remembers to. Hooks remove
 * that decision — the client calls us before each turn (recall) and after each
 * turn (capture).
 *
 * Hard requirements (all enforced here, all tested):
 *   - recall budget < 500 ms and FAIL OPEN: any error/timeout prints nothing
 *     and exits 0, so the agent is never blocked or broken.
 *   - secrets are redacted before anything is sent to the server.
 *   - capture is best-effort and never throws into the client.
 *
 * Claude Code hook contract (verified against the hooks reference):
 *   stdin  : JSON with session_id, transcript_path, cwd, hook_event_name, prompt
 *   stdout : for UserPromptSubmit, JSON `{hookSpecificOutput:{...,additionalContext}}`
 */
import { existsSync, readFileSync } from 'node:fs';

export const MANAGED_FLAG = '--managed-by-nexus';
export const RECALL_TIMEOUT_MS = 400;
export const CAPTURE_TIMEOUT_MS = 1500;
const MAX_TRANSCRIPT_CHARS = 200_000;

const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{8,}/g,
  /nx_(?:live|test)?_?[A-Za-z0-9_-]{8,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /AKIA[0-9A-Z]{12,}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(Bearer)\s+[A-Za-z0-9._-]{12,}/gi,
  /\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|API_KEY|APIKEY|ACCESS_KEY)[A-Z0-9_]*)\s*[:=]\s*["']?[^\s"',]{6,}/gi,
];

/** Remove credential-shaped strings before content leaves the machine. */
export function redactSecrets(input: string): string {
  let output = input;
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, (match, group?: string) =>
      group ? `${group}=***REDACTED***` : '***REDACTED***'
    );
  }
  return output;
}

export interface HookServerConfig {
  origin: string;
  apiKey: string;
}

interface JsonRpcResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

async function callTool(
  config: HookServerConfig,
  name: string,
  args: Record<string, unknown>,
  timeoutMs: number
): Promise<JsonRpcResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${config.origin.replace(/\/$/, '')}/api/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = (await response.json()) as {
      result?: JsonRpcResult;
      error?: { message?: string };
    };
    if (payload.error) throw new Error(payload.error.message ?? 'MCP error');
    return payload.result ?? {};
  } finally {
    clearTimeout(timer);
  }
}

function toolText(result: JsonRpcResult): string {
  return (result.content ?? [])
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text!)
    .join('\n');
}

/** Extract the useful lines from a `nexus_recall` payload, or null. */
function recallContext(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as {
      returned?: Array<{ title?: string; content?: string; type?: string }>;
    };
    const items = parsed.returned ?? [];
    if (!items.length) return null;
    const lines = items
      .slice(0, 8)
      .map((item) => `- ${item.title ?? item.type ?? 'memory'}: ${(item.content ?? '').slice(0, 300)}`);
    return `NEXUS recalled context:\n${lines.join('\n')}`;
  } catch {
    return null;
  }
}

export interface PromptHookResult {
  /** JSON to print on stdout, or null to print nothing. */
  stdout: string | null;
}

/**
 * UserPromptSubmit: recall for the prompt and return the hook output.
 * Never throws — a failure or timeout yields `{stdout: null}` (fail open).
 */
export async function recallForPrompt(
  prompt: string,
  config: HookServerConfig,
  options: { timeoutMs?: number } = {}
): Promise<PromptHookResult> {
  if (!prompt.trim()) return { stdout: null };
  try {
    const result = await callTool(
      config,
      'nexus_recall',
      { query: redactSecrets(prompt).slice(0, 2_000), budget: 900 },
      options.timeoutMs ?? RECALL_TIMEOUT_MS
    );
    if (result.isError) return { stdout: null };
    const context = recallContext(toolText(result));
    if (!context) return { stdout: null };
    return {
      stdout: JSON.stringify({
        hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context },
      }),
    };
  } catch {
    return { stdout: null };
  }
}

function readTranscript(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    const text = readFileSync(path, 'utf8');
    return text.length > MAX_TRANSCRIPT_CHARS ? text.slice(-MAX_TRANSCRIPT_CHARS) : text;
  } catch {
    return null;
  }
}

export interface StopHookPayload {
  transcript_path?: unknown;
  prompt?: unknown;
  last_assistant_message?: unknown;
  cwd?: unknown;
}

function payloadTranscript(payload: StopHookPayload): string | null {
  if (typeof payload.transcript_path === 'string') {
    const transcript = readTranscript(payload.transcript_path);
    if (transcript) return transcript;
  }
  const parts: string[] = [];
  if (typeof payload.prompt === 'string') parts.push(`User: ${payload.prompt}`);
  if (typeof payload.last_assistant_message === 'string') {
    parts.push(`Assistant: ${payload.last_assistant_message}`);
  }
  return parts.length ? parts.join('\n') : null;
}

/**
 * Stop / PreCompact / SessionStart: capture the turn.
 * Best-effort — never throws, never blocks the client on failure.
 */
export async function captureFromHook(
  payload: StopHookPayload,
  config: HookServerConfig,
  options: { timeoutMs?: number } = {}
): Promise<{ captured: boolean; characters: number }> {
  try {
    const transcript = payloadTranscript(payload);
    if (!transcript || transcript.trim().length < 20) return { captured: false, characters: 0 };
    const redacted = redactSecrets(transcript);
    const projectName =
      typeof payload.cwd === 'string' ? payload.cwd.split(/[\\/]/).filter(Boolean).pop() : undefined;
    const result = await callTool(
      config,
      'nexus_capture',
      { transcript: redacted, ...(projectName ? { projectName } : {}) },
      options.timeoutMs ?? CAPTURE_TIMEOUT_MS
    );
    return { captured: !result.isError, characters: redacted.length };
  } catch {
    return { captured: false, characters: 0 };
  }
}

/* ────────────────────────── Claude Code settings ────────────────────────── */

export interface ManagedHook {
  event: 'SessionStart' | 'UserPromptSubmit' | 'Stop' | 'PreCompact';
  action: 'recall' | 'capture';
  timeoutSeconds: number;
}

export const CLAUDE_HOOKS: ManagedHook[] = [
  { event: 'SessionStart', action: 'capture', timeoutSeconds: 10 },
  { event: 'UserPromptSubmit', action: 'recall', timeoutSeconds: 5 },
  { event: 'Stop', action: 'capture', timeoutSeconds: 10 },
  { event: 'PreCompact', action: 'capture', timeoutSeconds: 10 },
];

export function hookCommand(event: string, action: string, nexusScript: string): string {
  return `${JSON.stringify(process.execPath)} ${JSON.stringify(nexusScript)} hook ${action} ${MANAGED_FLAG}`;
}

type HookGroup = {
  matcher?: string;
  hooks?: Array<{ type?: string; command?: string; timeout?: number }>;
};

/** Add our hook entries without touching any user-defined hook. */
export function mergeClaudeHooks(
  settings: Record<string, unknown>,
  nexusScript: string
): Record<string, unknown> {
  const clone = structuredClone(settings);
  const hooks = (clone.hooks && typeof clone.hooks === 'object' ? clone.hooks : {}) as Record<
    string,
    HookGroup[]
  >;
  clone.hooks = hooks;

  for (const managed of CLAUDE_HOOKS) {
    const command = hookCommand(managed.event, managed.action, nexusScript);
    const groups = Array.isArray(hooks[managed.event]) ? hooks[managed.event]! : [];
    const alreadyManaged = groups.some((group) =>
      (group.hooks ?? []).some((hook) => (hook.command ?? '').includes(MANAGED_FLAG) && (hook.command ?? '').includes(`hook ${managed.action}`))
    );
    if (!alreadyManaged) {
      groups.push({
        hooks: [{ type: 'command', command, timeout: managed.timeoutSeconds }],
      });
    }
    hooks[managed.event] = groups;
  }
  return clone;
}

/** Remove only entries this connector added. */
export function removeClaudeHooks(settings: Record<string, unknown>): Record<string, unknown> {
  const clone = structuredClone(settings);
  const hooks = clone.hooks;
  if (!hooks || typeof hooks !== 'object') return clone;
  const record = hooks as Record<string, unknown>;
  for (const event of Object.keys(record)) {
    const groups = record[event];
    if (!Array.isArray(groups)) continue;
    const kept = (groups as HookGroup[])
      .map((group) => ({
        ...group,
        hooks: (group.hooks ?? []).filter((hook) => !(hook.command ?? '').includes(MANAGED_FLAG)),
      }))
      .filter((group) => (group.hooks?.length ?? 0) > 0);
    if (kept.length) record[event] = kept;
    else delete record[event];
  }
  return clone;
}

export function hooksInstalled(settings: Record<string, unknown>): boolean {
  const hooks = settings.hooks;
  if (!hooks || typeof hooks !== 'object') return false;
  return Object.values(hooks as Record<string, unknown>).some(
    (groups) =>
      Array.isArray(groups) &&
      (groups as HookGroup[]).some((group) =>
        (group.hooks ?? []).some((hook) => (hook.command ?? '').includes(MANAGED_FLAG))
      )
  );
}

/* ───────────────────────────── Hook CLI runner ──────────────────────────── */

export interface HookRunInput {
  action: string;
  stdin: string;
  config: HookServerConfig;
}

/**
 * Execute one hook invocation. Always resolves to the stdout string to emit
 * (empty means "say nothing"); never rejects.
 */
export async function runHook(input: HookRunInput): Promise<string> {
  try {
    const payload = input.stdin.trim() ? (JSON.parse(input.stdin) as StopHookPayload) : {};
    if (input.action === 'recall') {
      const prompt = typeof payload.prompt === 'string' ? payload.prompt : '';
      const result = await recallForPrompt(prompt, input.config);
      return result.stdout ?? '';
    }
    if (input.action === 'capture' || input.action === 'session-start') {
      await captureFromHook(payload, input.config);
      return '';
    }
    return '';
  } catch {
    return '';
  }
}
