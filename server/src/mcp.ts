/**
 * mcp.ts — MCP server factory (Model Context Protocol).
 * Tools, resources, and prompts are thin adapters over the same domain services
 * as REST. Each is gated by the caller's scopes — MCP never bypasses auth,
 * scopes, or the audit chain.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { sql, desc } from 'drizzle-orm';
import { createMemory, captureSession } from './services/memory.service.js';
import { recordFeedback } from './services/feedback.service.js';
import { isKillSwitchOn } from './services/safety.service.js';
import { recall } from './services/recall.js';
import { verifyAuditChain } from './lib/audit.js';
import { db, createApplicationSqlExecutor } from './db/client.js';
import { createExtendedSqlR1Runtime } from './services/r1-extended-runtime.js';
import { memories, skills, tokenLedger, auditLog, notes } from './db/client.js';
import { dbReachable } from './setup.js';
import type { Scope } from './lib/security.js';
import {
  spawnAgent,
  listAgents,
  enqueueTask,
  schedulerStatus,
  checkACL,
} from './services/kernel.js';

import { createCronJob, listCronJobs, ingestAmbientTranscript } from './services/operations-ext.js';
import { statsCache } from './lib/lru-cache.js';

/**
 * Scope required by each registered tool. Kept next to the registrations so the
 * generated README table and the code cannot drift; a test fails if a tool is
 * added without an entry here.
 */
export const TOOL_SCOPES = {
  nexus_recall: 'memory:read',
  nexus_context_pack: 'memory:read',
  nexus_remember: 'memory:write',
  nexus_capture: 'memory:write',
  nexus_feedback: 'memory:write',
  nexus_audit_verify: 'audit:read',
  nexus_stats: 'memory:read',
  nexus_delegate: 'brain:admin',
  nexus_agents: 'memory:read',
  nexus_scheduler: 'memory:read',
  nexus_cron_create: 'brain:admin',
  nexus_cron_list: 'memory:read',
  nexus_ambient_ingest: 'memory:write',
  nexus_acl_check: 'memory:read',
} as const satisfies Record<string, Scope>;

let extendedR1Runtime: ReturnType<typeof getExtendedR1RuntimeImpl> | undefined;
function getExtendedR1RuntimeImpl() {
  return createExtendedSqlR1Runtime(createApplicationSqlExecutor());
}
function getExtendedR1Runtime() {
  extendedR1Runtime ??= getExtendedR1RuntimeImpl();
  return extendedR1Runtime;
}

export function createNexusMcpServer(actor: string, scopes: Scope[]): McpServer {
  const server = new McpServer({ name: 'nexus-2', version: '2.0.0' });

  const can = (s: Scope) => scopes.includes(s);
  const deny = (tool: string, scope: Scope) => ({
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ error: 'FORBIDDEN', message: `${tool} requires scope ${scope}` }),
      },
    ],
    isError: true,
  });

  server.tool(
    'nexus_context_pack',
    'Bounded, provenance-backed project context for long-horizon agent handoff.',
    {
      projectId: z.string().uuid(),
      tokenBudget: z.number().int().min(100).max(100_000).default(4000),
      focus: z.string().max(500).optional(),
      taskId: z.string().uuid().optional(),
    },
    async ({ projectId, tokenBudget, focus, taskId }) => {
      if (!can('memory:read')) return deny('nexus_context_pack', 'memory:read');
      const runtime = getExtendedR1Runtime();
      const pack = await runtime.contextPack.build(projectId, { tokenBudget, focus, taskId });
      return { content: [{ type: 'text', text: JSON.stringify(pack) }] };
    }
  );

  server.tool(
    'nexus_recall',
    'Token-budgeted recall across memories, skills, and notes.',
    { query: z.string().min(1), budget: z.number().int().min(64).max(8192).default(1500) },
    async ({ query, budget }) => {
      if (!can('memory:read')) return deny('nexus_recall', 'memory:read');
      const result = await recall(query, budget, actor);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  server.tool(
    'nexus_remember',
    'Store a durable memory.',
    {
      kind: z.enum(['episodic', 'semantic', 'preference', 'reflexion', 'fact']).default('semantic'),
      title: z.string().min(1).max(200),
      content: z.string().min(1),
      tags: z.array(z.string()).default([]),
      importance: z.number().min(0).max(1).default(0.5),
      /** Which agent/client is writing (attribution, e.g. "claude-code"). */
      client: z.string().min(1).max(80).optional(),
    },
    async (args) => {
      if (!can('memory:write')) return deny('nexus_remember', 'memory:write');
      const created = await createMemory(
        {
          kind: args.kind,
          title: args.title,
          content: args.content,
          tags: args.tags,
          importance: args.importance,
          source: args.client ? `mcp:${args.client}` : 'mcp',
          projectId: null,
        },
        actor
      );
      return {
        content: [{ type: 'text', text: JSON.stringify({ stored: true, memory: created }) }],
      };
    }
  );

  server.tool(
    'nexus_capture',
    'Capture a session transcript and distill it (transcript is always preserved).',
    {
      transcript: z.string().min(1),
      projectName: z.string().optional(),
      client: z.string().min(1).max(80).optional(),
    },
    async ({ transcript, projectName, client }) => {
      if (!can('memory:write')) return deny('nexus_capture', 'memory:write');
      const report = await captureSession(transcript, projectName, actor, false, client);
      return { content: [{ type: 'text', text: JSON.stringify(report) }] };
    }
  );

  server.tool(
    'nexus_feedback',
    'Record recall relevance feedback.',
    {
      query: z.string().min(1),
      itemId: z.string().min(1),
      itemType: z.enum(['memory', 'skill', 'note']),
      helpful: z.boolean(),
    },
    async (args) => {
      if (!can('memory:write')) return deny('nexus_feedback', 'memory:write');
      await recordFeedback(args, actor);
      return { content: [{ type: 'text', text: JSON.stringify({ recorded: true }) }] };
    }
  );

  server.tool(
    'nexus_audit_verify',
    'Verify the integrity of the hash-chained audit log.',
    {},
    async () => {
      if (!can('audit:read')) return deny('nexus_audit_verify', 'audit:read');
      const result = await verifyAuditChain();
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  server.tool(
    'nexus_stats',
    'Return brain statistics: memory count, skill count, token footprint, audit entries, and DB health.',
    {},
    async () => {
      if (!can('memory:read')) return deny('nexus_stats', 'memory:read');
      // Check LRU cache first — bypasses 6 DB count queries on cache hit.
      const cached = statsCache.get('stats');
      if (cached) {
        return { content: [{ type: 'text', text: JSON.stringify(cached) }] };
      }
      const c = sql<number>`count(*)::int`;
      const sumTokens = sql<number>`coalesce(sum(token_cost), 0)::int`;
      const sumSaved = sql<number>`coalesce(sum(tokens_saved), 0)::int`;
      const [mem, skl, fp, sv, aud, nts] = await Promise.all([
        db.select({ n: c }).from(memories),
        db.select({ n: c }).from(skills),
        db.select({ total: sumTokens }).from(memories),
        db.select({ total: sumSaved }).from(tokenLedger),
        db.select({ n: c }).from(auditLog),
        db.select({ n: c }).from(notes),
      ]);
      const reachable = await dbReachable();
      const killSwitch = await isKillSwitchOn();
      const stats = {
        memories: mem[0]?.n ?? 0,
        skills: skl[0]?.n ?? 0,
        tokenFootprint: fp[0]?.total ?? 0,
        tokensSaved: sv[0]?.total ?? 0,
        auditEntries: aud[0]?.n ?? 0,
        notes: nts[0]?.n ?? 0,
        dbReachable: reachable,
        killSwitch,
      };
      statsCache.set('stats', stats);
      return { content: [{ type: 'text', text: JSON.stringify(stats) }] };
    }
  );

  /* ---- Resources ---- */

  server.resource(
    'stats',
    'nexus://brain/stats',
    { description: 'Brain statistics.', mimeType: 'application/json' },
    async () => {
      const c = sql<number>`count(*)::int`;
      const [mem, skl] = await Promise.all([
        db.select({ n: c }).from(memories),
        db.select({ n: c }).from(skills),
      ]);
      const text = JSON.stringify({ memories: mem[0]?.n ?? 0, skills: skl[0]?.n ?? 0 });
      return { contents: [{ uri: 'nexus://brain/stats', mimeType: 'application/json', text }] };
    }
  );

  server.resource(
    'health',
    'nexus://brain/health',
    { description: 'System health snapshot.', mimeType: 'application/json' },
    async () => {
      const reachable = await dbReachable();
      const killSwitch = await isKillSwitchOn();
      const audit = can('audit:read') ? await verifyAuditChain() : null;
      const text = JSON.stringify({
        db: reachable ? 'ok' : 'down',
        killSwitch,
        auditValid: audit?.valid ?? null,
        auditEntries: audit?.total ?? null,
      });
      return { contents: [{ uri: 'nexus://brain/health', mimeType: 'application/json', text }] };
    }
  );

  server.resource(
    'ambient',
    'nexus://brain/ambient',
    { description: 'Compact top-importance memory context.', mimeType: 'text/markdown' },
    async () => {
      const top = await db.query.memories.findMany({
        orderBy: desc(memories.importance),
        limit: 6,
      });
      const lines = [
        '# NEXUS ambient context',
        ...top.map((memory: { title: string }) => `- ${memory.title}`),
      ];
      const text = lines.join('\n');
      return { contents: [{ uri: 'nexus://brain/ambient', mimeType: 'text/markdown', text }] };
    }
  );

  /* ---- Prompts ---- */

  server.prompt('recall-and-execute', { query: z.string().min(1) }, async ({ query }) => ({
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: `Task: ${query}\n\nFirst call nexus_recall to ground yourself in relevant memories/skills/notes, then carry out the task using what you recalled.`,
        },
      },
    ],
  }));

  server.prompt('resume-work', {}, async () => ({
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: 'Read nexus://brain/ambient and nexus://brain/health, summarize where work left off, and propose the next concrete step.',
        },
      },
    ],
  }));

  server.prompt('capture-session', { transcript: z.string().min(1) }, async ({ transcript }) => ({
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: `Distill this transcript into durable memories and skills using nexus_capture, then summarize what was learned:\n\n${transcript.slice(0, 4000)}`,
        },
      },
    ],
  }));

  /* ---- Phase 3: Multi-Agent Delegation ---- */

  server.tool(
    'nexus_delegate',
    'Spawn a specialized sub-agent for a task.',
    {
      name: z.string().min(1),
      taskLabel: z.string().min(1),
      kind: z.enum(['sub-agent', 'daemon']).default('sub-agent'),
    },
    async ({ name, taskLabel, kind }) => {
      if (!can('brain:admin')) return deny('nexus_delegate', 'brain:admin');
      const agent = await spawnAgent(
        { name, kind, ring: 2, scopes: ['memory:read', 'memory:write'] },
        actor
      );
      if (!agent)
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'Failed to spawn agent' }) }],
          isError: true,
        };
      const task = await enqueueTask(
        { agentId: agent.id, label: taskLabel, kind: 'interactive' },
        actor
      );
      if (!task)
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'Failed to enqueue task' }) }],
          isError: true,
        };
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ agentId: agent.id, taskId: task.id, status: 'queued' }),
          },
        ],
      };
    }
  );

  server.tool('nexus_agents', 'List all registered agents and their states.', {}, async () => {
    if (!can('memory:read')) return deny('nexus_agents', 'memory:read');
    const agents = await listAgents();
    return { content: [{ type: 'text', text: JSON.stringify({ count: agents.length, agents }) }] };
  });

  server.tool('nexus_scheduler', 'Get scheduler queue status.', {}, async () => {
    if (!can('memory:read')) return deny('nexus_scheduler', 'memory:read');
    const status = await schedulerStatus();
    return { content: [{ type: 'text', text: JSON.stringify(status) }] };
  });

  /* ---- Phase 4: Cron Daemons ---- */

  server.tool(
    'nexus_cron_create',
    'Schedule a 24/7 autonomous daemon.',
    {
      name: z.string().min(1),
      cron: z.string().min(1),
      taskLabel: z.string().min(1),
    },
    async ({ name, cron, taskLabel }) => {
      if (!can('brain:admin')) return deny('nexus_cron_create', 'brain:admin');
      const job = await createCronJob({ name, cron, taskLabel }, actor);
      if (!job)
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'Failed to create cron job' }) }],
          isError: true,
        };
      return {
        content: [{ type: 'text', text: JSON.stringify({ jobId: job.id, scheduled: true }) }],
      };
    }
  );

  server.tool('nexus_cron_list', 'List all scheduled daemons.', {}, async () => {
    if (!can('memory:read')) return deny('nexus_cron_list', 'memory:read');
    const jobs = await listCronJobs();
    return { content: [{ type: 'text', text: JSON.stringify({ jobs }) }] };
  });

  /* ---- Phase 4: Ambient Ingestion ---- */

  server.tool(
    'nexus_ambient_ingest',
    'Ingest an ambient voice transcript for background distillation.',
    {
      transcript: z.string().min(1),
      source: z.string().default('ambient'),
    },
    async ({ transcript, source }) => {
      if (!can('memory:write')) return deny('nexus_ambient_ingest', 'memory:write');
      const result = await ingestAmbientTranscript(transcript, source, {}, actor);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  /* ---- ACL Check ---- */

  server.tool(
    'nexus_acl_check',
    'Check if an agent ring permits a tool.',
    {
      ring: z.number().int().min(0).max(4),
      tool: z.string(),
    },
    async ({ ring, tool }) => {
      if (!can('memory:read')) return deny('nexus_acl_check', 'memory:read');
      const allowed = checkACL(ring, tool);
      return { content: [{ type: 'text', text: JSON.stringify({ ring, tool, allowed }) }] };
    }
  );

  return server;
}
