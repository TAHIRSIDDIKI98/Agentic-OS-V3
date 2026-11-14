/**
 * Tests for the automatic capture hooks (Phase 2).
 *
 * The hook runtime is the piece that must never break an agent: every failure
 * path is asserted to exit quietly, and the recall budget is asserted in wall
 * clock time.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MANAGED_FLAG,
  captureFromHook,
  hooksInstalled,
  mergeClaudeHooks,
  redactSecrets,
  recallForPrompt,
  removeClaudeHooks,
  runHook,
} from '../src/connectors/agent-hooks.js';

interface Recorded {
  body: Record<string, unknown>;
}

async function startServer(
  handler: (body: Record<string, unknown>, res: ServerResponse) => void
): Promise<{ origin: string; requests: Recorded[]; close: () => Promise<void> }> {
  const requests: Recorded[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      requests.push({ body });
      handler(body, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        // Aborted (timeout) requests would otherwise keep close() pending.
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function rpcOk(text: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }] } });
}

const openServers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of openServers.splice(0)) await close();
});

describe('hook secret redaction', () => {
  it('removes credential-shaped strings', () => {
    const input = [
      'token sk-abcdef1234567890',
      'nx key nx_live_abcdef1234567890',
      'aws AKIAIOSFODNN7EXAMPLE',
      'github ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'Authorization: Bearer abcdefghijklmnopqrstuvwxyz',
      'DB_PASSWORD=hunter2hunter2',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----',
    ].join('\n');

    const redacted = redactSecrets(input);

    expect(redacted).not.toContain('sk-abcdef1234567890');
    expect(redacted).not.toContain('nx_live_abcdef1234567890');
    expect(redacted).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(redacted).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(redacted).not.toContain('hunter2hunter2');
    expect(redacted).not.toContain('MIIE...');
    expect(redacted).toContain('***REDACTED***');
  });

  it('leaves ordinary text untouched', () => {
    const text = 'We deploy with docker compose on port 8080.';
    expect(redactSecrets(text)).toBe(text);
  });
});

describe('UserPromptSubmit recall hook', () => {
  it('injects recall results and redacts the query', async () => {
    const server = await startServer((_body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        rpcOk(
          JSON.stringify({
            returned: [{ title: 'Deployment', content: 'we deploy with docker compose on port 8080' }],
          })
        )
      );
    });
    openServers.push(server.close);

    const result = await recallForPrompt(
      'how do we deploy? token sk-secretvalue123456',
      { origin: server.origin, apiKey: 'nx_test' }
    );

    expect(result.stdout).not.toBeNull();
    const parsed = JSON.parse(result.stdout!) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(parsed.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('docker compose');

    const sent = server.requests[0]!.body as {
      params: { arguments: { query: string } };
    };
    expect(sent.params.arguments.query).toContain('***REDACTED***');
    expect(sent.params.arguments.query).not.toContain('sk-secretvalue123456');
  });

  it('fails open when the server is unreachable', async () => {
    const server = await startServer((_body, res) => res.end('{}'));
    const origin = server.origin;
    await server.close();

    const started = performance.now();
    const result = await recallForPrompt('anything', { origin, apiKey: 'nx_test' });
    const elapsed = performance.now() - started;

    expect(result.stdout).toBeNull();
    expect(elapsed).toBeLessThan(500);
  });

  it('fails open within the budget when the server hangs', async () => {
    const server = await startServer(() => {
      /* never responds */
    });
    openServers.push(server.close);

    const started = performance.now();
    const result = await recallForPrompt('anything', { origin: server.origin, apiKey: 'nx_test' }, { timeoutMs: 100 });
    const elapsed = performance.now() - started;

    expect(result.stdout).toBeNull();
    expect(elapsed).toBeLessThan(800);
  });

  it('returns nothing for an empty prompt', async () => {
    const result = await recallForPrompt('   ', { origin: 'http://127.0.0.1:1', apiKey: 'x' });
    expect(result.stdout).toBeNull();
  });
});

describe('Stop capture hook', () => {
  it('captures a redacted transcript with the project name', async () => {
    const server = await startServer((_body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(rpcOk(JSON.stringify({ distilled: true, transcriptPreserved: true })));
    });
    openServers.push(server.close);

    const result = await captureFromHook(
      {
        cwd: '/repo/my-app',
        prompt: 'deploy with docker compose',
        last_assistant_message: 'done; key was sk-supersecret12345',
      },
      { origin: server.origin, apiKey: 'nx_test' }
    );

    expect(result.captured).toBe(true);
    const body = server.requests[0]!.body as {
      params: { name: string; arguments: { transcript: string; projectName?: string } };
    };
    expect(body.params.name).toBe('nexus_capture');
    expect(body.params.arguments.projectName).toBe('my-app');
    expect(body.params.arguments.transcript).toContain('***REDACTED***');
    expect(body.params.arguments.transcript).not.toContain('sk-supersecret12345');
  });

  it('does nothing when there is no transcript', async () => {
    const result = await captureFromHook({}, { origin: 'http://127.0.0.1:1', apiKey: 'x' });
    expect(result).toEqual({ captured: false, characters: 0 });
  });
});

describe('runHook', () => {
  it('never throws on malformed stdin', async () => {
    await expect(
      runHook({ action: 'recall', stdin: '{not json', config: { origin: 'http://127.0.0.1:1', apiKey: 'x' } })
    ).resolves.toBe('');
  });

  it('returns capture output as empty stdout', async () => {
    await expect(
      runHook({
        action: 'capture',
        stdin: JSON.stringify({ prompt: 'short' }),
        config: { origin: 'http://127.0.0.1:1', apiKey: 'x' },
      })
    ).resolves.toBe('');
  });
});

describe('Claude Code hook settings', () => {
  it('adds all four events once and preserves user hooks', () => {
    const userSettings = {
      theme: 'dark',
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'echo user-hook' }] }],
      },
    };

    const once = mergeClaudeHooks(userSettings, '/opt/nexus.js');
    const twice = mergeClaudeHooks(once, '/opt/nexus.js');

    expect(twice).toEqual(once);
    const hooks = twice.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    expect(Object.keys(hooks).sort()).toEqual(['PreCompact', 'SessionStart', 'Stop', 'UserPromptSubmit']);
    expect(hooks.Stop!.some((group) => group.hooks.some((hook) => hook.command === 'echo user-hook'))).toBe(true);
    expect(
      hooks.Stop!.some((group) => group.hooks.some((hook) => hook.command.includes(MANAGED_FLAG)))
    ).toBe(true);
    expect(twice.theme).toBe('dark');
  });

  it('removes only managed hooks', () => {
    const merged = mergeClaudeHooks(
      { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo user-hook' }] }] } },
      '/opt/nexus.js'
    );
    expect(hooksInstalled(merged)).toBe(true);

    const cleaned = removeClaudeHooks(merged);
    expect(hooksInstalled(cleaned)).toBe(false);
    const hooks = cleaned.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    expect(hooks.Stop).toHaveLength(1);
    expect(hooks.Stop![0]!.hooks[0]!.command).toBe('echo user-hook');
    expect(cleaned.hooks).not.toHaveProperty('UserPromptSubmit');
  });
});
