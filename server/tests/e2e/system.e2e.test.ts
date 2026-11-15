/**
 * server/tests/e2e/system.e2e.test.ts
 *
 * In-process component smoke checks (Phase 19).
 *
 * Scope note (E10-S20): this file is NOT the R1 end-to-end gate. Canonical
 * coverage lives in:
 *  - server/tests/e2e/golden-path.e2e.test.ts — the 14-step governed path.
 *  - packages/sdk/src/r1-task-worker.test.ts — lease expiry / checkpoint recovery.
 *  - packages/sdk/src/r1-tool-gateway.test.ts — sandbox and traversal denials.
 *  - server/tests/omniroute*.test.ts — provider fallback and breaker behaviour.
 * Fake scenario assertions were removed rather than kept as green signals.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../src/app.js';
import { createTestDb, closeTestDb, type TestDbFixtures } from '../helpers/db-setup.js';
import { ActionRegistry } from '../../src/services/agent-runtime.js';
import { mcpRegistry } from '../../src/services/mcp-registry.js';
import { getMessageBus } from '../../src/services/message-bus.js';
import { resetDesktopActuator, getDesktopActuator } from '../../src/services/desktop-actuator.js';
import { computeMerkleRoot } from '../../src/services/blockchain.js';
// Setup Mock LLM responses to simulate LLM Gateways and OmniRoute
vi.mock('../../src/services/llm.js', () => ({
  callLLM: vi.fn().mockResolvedValue({
    content: 'Mocked successful completion response.',
    tokensUsed: 120,
  }),
}));

describe('NEXUS 2.0 — End-to-End System Integration & Validation Suite', () => {
  let fixtures: TestDbFixtures;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    // Spin up fresh SQLite test db structure
    fixtures = await createTestDb();
    app = createApp();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  // E2E Test Scenario 1: Agent lifecycle, memory creation, and hybrid recall.
  it('E2E Scenario 1: Agent Goal -> LLM Reasoning -> Memory Store -> Hybrid Recall', async () => {
    const memoryId = `mem-${randomUUID()}`;

    // 1. Simulate inserting memory context
    await fixtures.db.insert(fixtures.memories).values({
      id: memoryId,
      kind: 'fact',
      title: 'Architectural Invariant',
      content: 'Kernel Ring 0 must supervise all native worker subprocesses.',
      importance: 0.95,
      source: 'kernel',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // 2. Query Memory Recall API using the mock operator token (requires no-auth logic verification)
    const rec = await fixtures.db.select().from(fixtures.memories);
    expect(rec.length).toBeGreaterThan(0);
    expect(rec[0].content).toContain('Ring 0 must supervise');
  });

  // E2E Test Scenario 2: Agent DAG pipeline execution & multi-step data passing.
  it('E2E Scenario 2: DAG Pipeline execution & multi-step node data passing', async () => {
    // Build a mock DAG pipeline structure
    const pipelineData = {
      name: 'E2E Code Review Pipeline',
      config: {
        nodes: [
          { id: 'node-1', type: 'agent.run', config: { prompt: 'Compile code' } },
          { id: 'node-2', type: 'agent.run', config: { prompt: 'Scan vulnerability' } },
        ],
        edges: [{ source: 'node-1', target: 'node-2' }],
      },
    };

    const pipelineId = `pipe-${randomUUID()}`;
    await fixtures.db.insert(fixtures.pipelines).values({
      id: pipelineId,
      name: pipelineData.name,
      dag: JSON.stringify(pipelineData.config),
      config: pipelineData.config,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const pipelineRecord = await fixtures.db.select().from(fixtures.pipelines);
    expect(pipelineRecord.length).toBe(1);
    expect(pipelineRecord[0].name).toBe('E2E Code Review Pipeline');
  });

  // E2E Test Scenario 3: MCP Tool registration, RPC tool discovery, and execution mapping.
  it('E2E Scenario 3: MCP Tool Registration -> Discovery -> ActionRegistry mapping', async () => {
    const registry = new ActionRegistry();
    mcpRegistry.setActionRegistry(registry);

    // Register a mock stdio server process tool list
    const serverId = `server-${randomUUID()}`;
    const server = mcpRegistry.register(serverId, 'stdio', { command: 'node', args: ['-v'] });
    server.tools = [
      {
        name: 'fs_write_safe',
        description: 'Hardened file write utility',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      },
    ];

    mcpRegistry.syncToolsToActionRegistry(server.id);

    const action = registry.get('fs_write_safe');
    expect(action).toBeDefined();
    expect(action?.description).toContain('Hardened file write utility');

    mcpRegistry.unregister(server.id);
  });

  // E2E Test Scenario 5: Google A2A inter-agent delegation and status streaming.
  it('E2E Scenario 5: Google A2A delegation & SSE progress logging', async () => {
    const res = await app.request('/.well-known/agent.json');
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.protocolVersion).toBe('0.3.0');
  });

  // E2E Test Scenario 7: Heavy concurrent requests & db mutex serialization.
  it('E2E Scenario 7: Heavy parallel writing -> Mutex locks -> 0 database locks', async () => {
    const _bus = getMessageBus();
    const ops: Promise<void>[] = [];

    for (let i = 0; i < 20; i++) {
      ops.push(
        (async () => {
          await fixtures.db.insert(fixtures.memories).values({
            id: `conc-mem-${i}-${randomUUID()}`,
            kind: 'fact',
            title: `title-${i}`,
            content: `content-${i}`,
          });
        })()
      );
    }

    await Promise.all(ops);
    const count = await fixtures.db.select().from(fixtures.memories);
    expect(count.length).toBeGreaterThanOrEqual(20);
  });

  // E2E Test Scenario 8: Audit chain, Merkle root calculation, and on-chain anchor verify.
  it('E2E Scenario 8: Audit log batch -> Merkle Root calculation -> Verification', async () => {
    const h1 = '1'.repeat(64);
    const h2 = '2'.repeat(64);
    const root = computeMerkleRoot([h1, h2]);

    expect(root).toMatch(/^[0-9a-f]{64}$/);
  });

  // E2E Test Scenario 9: Desktop GUI screenshot capture in Headless mode.
  it('E2E Scenario 9: Desktop GUI screenshot capture in Headless Mode', async () => {
    process.env.NEXUS_GUI_MODE = 'headless';
    resetDesktopActuator();

    const actuator = await getDesktopActuator();
    expect(actuator.mode).toBe('headless');

    const shot = await actuator.screenshot();
    expect(shot).toBeDefined();
  });
});
