/**
 * Extended R1 routes covering E2-S2 through E9
 * This router extends the existing r1 router with new capabilities.
 * All handlers use typed validation and delegate to SDK services.
 */
import { Hono } from 'hono';
import { R1RecallQuerySchema } from '@agentic-os/sdk';
import { requireScope, fail } from '../lib/auth-context.js';
import type { NexusEnv } from '../lib/hono-env.js';
import type { ExtendedR1Runtime } from '../services/r1-extended-runtime.js';

export function createExtendedR1Router(runtime: ExtendedR1Runtime): Hono<NexusEnv> {
  const router = new Hono<NexusEnv>();
  router.onError((error, context) => fail(context, error));

  // --- E2-S2 Recall ---
  router.post('/projects/:projectId/recall', async (c) => {
    await requireScope(c, 'memory:read');
    const projectId = c.req.param('projectId');
    const body = await c.req.json();
    const query = R1RecallQuerySchema.parse({ ...body, projectId });
    const result = await runtime.recall.recall(query);
    runtime.telemetry.recallMode(result.modeUsed, projectId);
    return c.json(result, 200);
  });

  // --- Bounded context pack (long-horizon agent handoff) ---
  router.get('/projects/:projectId/context', async (c) => {
    await requireScope(c, 'memory:read');
    const projectId = c.req.param('projectId');
    if (!(await runtime.repositories.projects.get(projectId))) {
      return c.json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found.' } }, 404);
    }
    const tokenBudget = Number(c.req.query('tokenBudget') ?? '4000');
    if (!Number.isInteger(tokenBudget) || tokenBudget < 100 || tokenBudget > 100_000) {
      return c.json(
        {
          error: {
            code: 'INVALID',
            message: 'tokenBudget must be an integer between 100 and 100000',
          },
        },
        400
      );
    }
    const focus = c.req.query('focus');
    const taskId = c.req.query('taskId');
    return c.json(await runtime.contextPack.build(projectId, { tokenBudget, focus, taskId }), 200);
  });

  // --- E2-S3 Feedback ---
  router.post('/projects/:projectId/recall/feedback', async (c) => {
    const principal = await requireScope(c, 'memory:write');
    const projectId = c.req.param('projectId');
    const body = await c.req.json();
    const feedback = await runtime.feedback.recordFeedback({
      projectId,
      query: body.query,
      resultId: body.resultId,
      actorId: principal.id,
      helpful: body.helpful,
      comment: body.comment,
      evidenceIds: body.evidenceIds,
    });
    runtime.telemetry.recallUsefulness(feedback.feedback.resultId, feedback.feedback.helpful, projectId);
    return c.json(feedback.feedback, 201);
  });

  router.get('/projects/:projectId/recall/feedback', async (c) => {
    await requireScope(c, 'memory:read');
    const projectId = c.req.param('projectId');
    const resultId = c.req.query('resultId');
    return c.json({ feedback: await runtime.feedback.listFeedback(projectId, resultId) }, 200);
  });

  router.get('/projects/:projectId/recall/explain', async (c) => {
    await requireScope(c, 'memory:read');
    const projectId = c.req.param('projectId');
    const resultId = c.req.query('resultId');
    if (!resultId) return c.json({ error: { code: 'INVALID', message: 'resultId required' } }, 400);
    return c.json(await runtime.feedback.explainResult(projectId, resultId), 200);
  });

  router.post('/projects/:projectId/contradictions', async (c) => {
    await requireScope(c, 'memory:write');
    const projectId = c.req.param('projectId');
    const body = await c.req.json();
    const result = await runtime.feedback.flagContradiction({ projectId, ...body });
    return c.json(result.signal, 201);
  });

  router.get('/projects/:projectId/contradictions', async (c) => {
    await requireScope(c, 'memory:read');
    return c.json({ contradictions: await runtime.feedback.listContradictions(c.req.param('projectId')) }, 200);
  });

  // --- E3-S2 Checkpointed worker ---
  router.post('/projects/:projectId/tasks/:taskId/checkpoints', async (c) => {
    await requireScope(c, 'memory:write');
    const { projectId, taskId } = c.req.param();
    const body = await c.req.json();
    const cp = await runtime.worker.checkpoint(projectId, taskId, body.stepId ?? 'unknown', body.snapshot ?? {});
    const span = runtime.telemetry.startSpan({ kind: 'checkpoint', name: `checkpoint-${cp.sequence}`, projectId, taskId });
    runtime.telemetry.endSpan(span.spanId, 'ok');
    return c.json(cp, 201);
  });

  router.get('/projects/:projectId/tasks/:taskId/checkpoints', async (c) => {
    await requireScope(c, 'memory:read');
    const { projectId, taskId } = c.req.param();
    return c.json({ checkpoints: await runtime.worker.listCheckpoints(projectId, taskId) }, 200);
  });

  router.post('/projects/:projectId/tasks/claim', async (c) => {
    await requireScope(c, 'memory:write');
    const projectId = c.req.param('projectId');
    const result = await runtime.worker.claimNext(projectId);
    if (!result) return c.json({ claimed: false }, 200);
    const span = runtime.telemetry.startSpan({ kind: 'task', name: `claim-${result.task.id}`, projectId, taskId: result.task.id });
    runtime.telemetry.endSpan(span.spanId, 'ok');
    return c.json({ claimed: true, task: result.task, lease: result.lease }, 200);
  });

  router.post('/projects/:projectId/tasks/:taskId/heartbeat', async (c) => {
    await requireScope(c, 'memory:write');
    const { projectId, taskId } = c.req.param();
    const lease = await runtime.worker.heartbeat(projectId, taskId);
    if (!lease) return c.json({ error: { code: 'LEASE_NOT_FOUND', message: 'Lease not found or expired' } }, 404);
    return c.json(lease, 200);
  });

  router.get('/projects/:projectId/worker/recover', async (c) => {
    await requireScope(c, 'brain:admin');
    return c.json({ recovered: await runtime.worker.recoverExpired() }, 200);
  });

  // Claimed effects are intentionally never replayed automatically. Operators
  // inspect this bounded list before choosing a manual reconciliation action.
  router.get('/projects/:projectId/effects/recovery', async (c) => {
    await requireScope(c, 'brain:admin');
    const projectId = c.req.param('projectId');
    const requestedAgeMs = Number(c.req.query('olderThanMs') ?? 30_000);
    if (!Number.isInteger(requestedAgeMs) || requestedAgeMs < 1_000 || requestedAgeMs > 86_400_000) {
      return c.json({ error: { code: 'INVALID', message: 'olderThanMs must be an integer between 1000 and 86400000' } }, 400);
    }
    const before = new Date(Date.now() - requestedAgeMs).toISOString();
    return c.json({ claims: await runtime.effectClaims.listStale(projectId, before), reconciliationRequired: true }, 200);
  });

  // --- E3-S3 Retry/cancel/recovery ---
  router.post('/projects/:projectId/tasks/:taskId/cancel', async (c) => {
    await requireScope(c, 'memory:write');
    const { projectId, taskId } = c.req.param();
    const task = await runtime.worker.cancel(projectId, taskId);
    runtime.telemetry.taskOutcome(taskId, projectId, 'canceled');
    return c.json(task, 200);
  });

  router.post('/projects/:projectId/tasks/:taskId/retry', async (c) => {
    await requireScope(c, 'memory:write');
    const { projectId, taskId } = c.req.param();
    const task = await runtime.worker.retry(projectId, taskId);
    runtime.telemetry.retry(taskId, projectId, 1);
    return c.json(task, 200);
  });

  router.get('/projects/:projectId/tasks/:taskId/recovery', async (c) => {
    await requireScope(c, 'memory:read');
    const { projectId, taskId } = c.req.param();
    return c.json(await runtime.worker.exposeFailedTaskInfo(projectId, taskId), 200);
  });

  router.post('/projects/:projectId/tasks/:taskId/fail', async (c) => {
    await requireScope(c, 'memory:write');
    const { projectId, taskId } = c.req.param();
    const body = await c.req.json();
    return c.json(await runtime.worker.handleFailure(projectId, taskId, body.classification ?? 'transient'), 200);
  });

  router.post('/projects/:projectId/tasks/:taskId/compensations', async (c) => {
    await requireScope(c, 'memory:write');
    const { projectId, taskId } = c.req.param();
    const body = await c.req.json();
    return c.json(await runtime.worker.createCompensation(projectId, taskId, body.targetStepId, body.reason ?? 'compensation'), 201);
  });

  // --- E3-S4 Event stream ---
  router.get('/projects/:projectId/tasks/:taskId/events/stream', async (c) => {
    await requireScope(c, 'memory:read');
    const { projectId, taskId } = c.req.param();
    const cursorStr = c.req.query('cursor');
    const cursor = cursorStr ? Number(cursorStr) : undefined;
    const result = await runtime.eventStream.replay(projectId, taskId, cursor);
    if (result.resyncRequired) return c.json({ resyncRequired: true, nextCursor: result.nextCursor }, 200);
    // Return SSE-like JSON for simplicity; real SSE uses separate transport
    return c.json({ events: result.events, nextCursor: result.nextCursor, resyncRequired: false }, 200);
  });

  router.get('/projects/:projectId/tasks/:taskId/events/sse', async (c) => {
    await requireScope(c, 'memory:read');
    const { projectId, taskId } = c.req.param();
    const cursorStr = c.req.query('cursor');
    const cursor = cursorStr ? Number(cursorStr) : undefined;
    const result = await runtime.eventStream.replay(projectId, taskId, cursor);

    // Return as SSE stream
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        for (const ev of result.events) {
          const chunk = `id: ${ev.id}\nevent: task.${ev.event}\ndata: ${JSON.stringify(ev)}\n\n`;
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    });
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  });

  // --- E4-S2 Durable approvals ---
  router.post('/projects/:projectId/approvals', async (c) => {
    const principal = await requireScope(c, 'memory:write');
    const projectId = c.req.param('projectId');
    const body = await c.req.json();
    const req = await runtime.approvals.requestApproval({
      projectId,
      taskId: body.taskId,
      capabilityId: body.capabilityId,
      tool: body.tool,
      args: body.args,
      riskReason: body.riskReason,
      policyVersion: body.policyVersion,
      agentId: body.agentId,
      actorId: principal.id,
      ttlMs: body.ttlMs,
    });
    return c.json(req, 201);
  });

  router.post('/projects/:projectId/approvals/:approvalId/decide', async (c) => {
    const principal = await requireScope(c, 'memory:write');
    const { projectId, approvalId } = c.req.param();
    const body = await c.req.json();
    const before = await runtime.approvals.get(projectId, approvalId);
    const start = before ? new Date(before.createdAt).getTime() : Date.now();
    const result = await runtime.approvals.decide({
      projectId,
      approvalId,
      decision: body.decision,
      actorId: principal.id,
      actionHash: body.actionHash,
      policyVersion: body.policyVersion,
    });
    const latency = Date.now() - start;
    runtime.telemetry.approvalLatency(approvalId, latency, projectId);
    return c.json(result, 200);
  });

  router.get('/projects/:projectId/approvals', async (c) => {
    await requireScope(c, 'memory:read');
    return c.json({ approvals: await runtime.approvals.listPending(c.req.param('projectId')) }, 200);
  });

  router.get('/projects/:projectId/approvals/:approvalId', async (c) => {
    await requireScope(c, 'memory:read');
    const { projectId, approvalId } = c.req.param();
    const appr = await runtime.approvals.get(projectId, approvalId);
    if (!appr) return c.json({ error: { code: 'NOT_FOUND', message: 'Approval not found' } }, 404);
    return c.json(appr, 200);
  });

  // --- E4-S3 Tool gateway ---
  router.post('/projects/:projectId/tool/read', async (c) => {
    await requireScope(c, 'memory:read');
    const projectId = c.req.param('projectId');
    const body = await c.req.json();
    return c.json(await runtime.toolGateway.readFile({ projectId, ...body }), 200);
  });

  router.post('/projects/:projectId/tool/write', async (c) => {
    await requireScope(c, 'memory:write');
    const projectId = c.req.param('projectId');
    const body = await c.req.json();
    const result = await runtime.toolGateway.writeFile({ projectId, ...body });
    const span = runtime.telemetry.startSpan({ kind: 'tool', name: `write-${body.path}`, projectId, taskId: body.taskId });
    runtime.telemetry.endSpan(span.spanId, result.ok ? 'ok' : 'error');
    if (!result.ok) runtime.telemetry.toolFailure('write-file', projectId, body.taskId);
    return c.json(result, result.ok ? 200 : 403);
  });

  router.post('/projects/:projectId/tool/exec', async (c) => {
    await requireScope(c, 'memory:write');
    const projectId = c.req.param('projectId');
    const body = await c.req.json();
    const result = await runtime.toolGateway.runConstrainedCommand({ projectId, ...body });
    const span = runtime.telemetry.startSpan({ kind: 'tool', name: `exec-${body.command}`, projectId, taskId: body.taskId });
    runtime.telemetry.endSpan(span.spanId, result.ok ? 'ok' : 'error');
    if (!result.ok) runtime.telemetry.toolFailure(body.command, projectId, body.taskId);
    return c.json(result, result.ok ? 200 : 403);
  });

  // --- E4-S4 Kill switch ---
  router.post('/projects/:projectId/kill-switch/enable', async (c) => {
    const principal = await requireScope(c, 'brain:admin');
    const projectId = c.req.param('projectId');
    const body = await c.req.json();
    const result = await runtime.killSwitch.enable({ reason: body.reason, actorId: principal.id, projectId, global: body.global });
    return c.json(result.state, 200);
  });

  router.post('/kill-switch/enable', async (c) => {
    const principal = await requireScope(c, 'brain:admin');
    const body = await c.req.json();
    const result = await runtime.killSwitch.enable({ reason: body.reason, actorId: principal.id, global: true });
    return c.json(result.state, 200);
  });

  router.post('/projects/:projectId/kill-switch/disable', async (c) => {
    const principal = await requireScope(c, 'brain:admin');
    const body = await c.req.json();
    const result = await runtime.killSwitch.disable({ actorId: principal.id, reason: body.reason });
    return c.json(result.state, 200);
  });

  router.post('/kill-switch/disable', async (c) => {
    const principal = await requireScope(c, 'brain:admin');
    const body = await c.req.json();
    const result = await runtime.killSwitch.disable({ actorId: principal.id, reason: body.reason });
    return c.json(result.state, 200);
  });

  router.get('/kill-switch/status', async (c) => {
    await requireScope(c, 'memory:read');
    return c.json(await runtime.killSwitch.status(), 200);
  });

  router.get('/projects/:projectId/kill-switch/status', async (c) => {
    await requireScope(c, 'memory:read');
    const projectId = c.req.param('projectId');
    const status = await runtime.killSwitch.status();
    return c.json({ ...status, enabled: await runtime.killSwitch.isEnabled(projectId) }, 200);
  });

  router.post('/projects/:projectId/quarantine', async (c) => {
    const principal = await requireScope(c, 'brain:admin');
    const { projectId } = c.req.param();
    const body = await c.req.json();
    return c.json(await runtime.killSwitch.quarantineTask(projectId, body.taskId, body.reason ?? 'quarantine', principal.id), 200);
  });

  router.get('/projects/:projectId/quarantine', async (c) => {
    await requireScope(c, 'memory:read');
    return c.json({ quarantined: await runtime.killSwitch.listQuarantined(c.req.param('projectId')) }, 200);
  });

  // --- E5-S2 Telemetry ---
  router.get('/projects/:projectId/telemetry', async (c) => {
    await requireScope(c, 'memory:read');
    return c.json({ spans: runtime.telemetry.listSpans(), metrics: runtime.telemetry.listMetrics() }, 200);
  });

  router.post('/projects/:projectId/telemetry/flush', async (c) => {
    await requireScope(c, 'brain:admin');
    await runtime.telemetry.flush();
    return c.json({ flushed: true }, 200);
  });

  // --- E5-S3 Evidence timeline ---
  router.get('/projects/:projectId/evidence/timeline', async (c) => {
    await requireScope(c, 'memory:read');
    const projectId = c.req.param('projectId');
    const taskId = c.req.query('taskId');
    return c.json({ timeline: await runtime.evidenceTimeline.buildTimeline(projectId, taskId) }, 200);
  });

  router.get('/projects/:projectId/evidence/export', async (c) => {
    await requireScope(c, 'memory:read');
    const projectId = c.req.param('projectId');
    const taskIdsParam = c.req.query('taskIds');
    const taskIds = taskIdsParam ? taskIdsParam.split(',') : undefined;
    const exp = await runtime.evidenceTimeline.exportEvidence(projectId, { taskIds, includeApprovals: true, includeReceipts: true, includeEvidence: true, includeSteps: true });
    return c.json(exp, 200);
  });

  // --- E9 Serena Parity ---
  router.post('/projects/:projectId/code/index', async (c) => {
    await requireScope(c, 'memory:read');
    const projectId = c.req.param('projectId');
    const body = await c.req.json();
    const root = body.root ?? process.cwd();
    const index = await runtime.serena.indexProject(projectId, root);
    return c.json({ indexedAt: index.indexedAt, files: index.files.length, symbols: index.symbols.length }, 200);
  });

  router.get('/projects/:projectId/code/map', async (c) => {
    await requireScope(c, 'memory:read');
    const projectId = c.req.param('projectId');
    const map = runtime.serena.getProjectMap(projectId);
    if (!map) return c.json({ error: { code: 'NOT_INDEXED', message: 'Project not indexed' } }, 404);
    return c.json({ files: map.files, symbols: map.symbols.length, indexedAt: map.indexedAt, outline: Object.keys(map.map).slice(0, 100) }, 200);
  });

  router.post('/projects/:projectId/code/find-symbols', async (c) => {
    await requireScope(c, 'memory:read');
    const projectId = c.req.param('projectId');
    const body = await c.req.json();
    return c.json({ symbols: await runtime.serena.findSymbols({ projectId, ...body }) }, 200);
  });

  router.post('/projects/:projectId/code/symbol-info', async (c) => {
    await requireScope(c, 'memory:read');
    const projectId = c.req.param('projectId');
    const body = await c.req.json();
    const root = body.root ?? process.cwd();
    return c.json(await runtime.serena.getSymbolInfo({ projectId, ...body }, root), 200);
  });

  router.post('/projects/:projectId/code/references', async (c) => {
    await requireScope(c, 'memory:read');
    const projectId = c.req.param('projectId');
    const body = await c.req.json();
    return c.json({ references: await runtime.serena.listReferences(projectId, body.symbolName) }, 200);
  });

  router.post('/projects/:projectId/code/semantic-search', async (c) => {
    await requireScope(c, 'memory:read');
    const projectId = c.req.param('projectId');
    const body = await c.req.json();
    return c.json({ results: await runtime.serena.semanticSearch(projectId, body.query, body.limit) }, 200);
  });

  router.post('/projects/:projectId/code/read-symbol', async (c) => {
    await requireScope(c, 'memory:read');
    const projectId = c.req.param('projectId');
    const body = await c.req.json();
    const root = body.root ?? process.cwd();
    return c.json(await runtime.serena.readSymbol(projectId, body.file, body.symbolName, root), 200);
  });

  router.get('/projects/:projectId/code/diagnostics', async (c) => {
    await requireScope(c, 'memory:read');
    return c.json({ diagnostics: await runtime.serena.getDiagnostics(c.req.param('projectId')) }, 200);
  });

  router.post('/projects/:projectId/code/edit', async (c) => {
    await requireScope(c, 'memory:write');
    const projectId = c.req.param('projectId');
    const body = await c.req.json();
    const root = body.root ?? process.cwd();
    const result = await runtime.serena.editAtSymbol({ projectId, file: body.file, symbolName: body.symbolName, newContent: body.newContent, approvalId: body.approvalId, projectRoot: root });
    return c.json(result, 200);
  });

  router.post('/projects/:projectId/code/rename', async (c) => {
    await requireScope(c, 'memory:write');
    const projectId = c.req.param('projectId');
    const body = await c.req.json();
    const root = body.root ?? process.cwd();
    return c.json(await runtime.serena.renameSymbol({ projectId, oldName: body.oldName, newName: body.newName, projectRoot: root }), 200);
  });

  // --- E7-S1 MCP capability adapter ---
  router.get('/mcp/compatibility', async (c) => {
    await requireScope(c, 'memory:read');
    return c.json(runtime.mcp.getCompatibilityMatrix(), 200);
  });

  router.get('/projects/:projectId/mcp/servers', async (c) => {
    await requireScope(c, 'memory:read');
    const projectId = c.req.param('projectId');
    // owner derived from principal, but for R1 we list by project owner? Use projectId as owner filter for demo
    const result = await runtime.mcp.discover(projectId);
    return c.json(result, 200);
  });

  router.post('/projects/:projectId/mcp/servers', async (c) => {
    await requireScope(c, 'brain:admin');
    const body = await c.req.json();
    const server = await runtime.mcp.register(body);
    return c.json(server, 201);
  });

  router.get('/projects/:projectId/mcp/servers/:serverId/tools', async (c) => {
    await requireScope(c, 'memory:read');
    const serverId = c.req.param('serverId');
    return c.json({ tools: await runtime.mcp.listTools(serverId) }, 200);
  });

  router.post('/projects/:projectId/mcp/servers/:serverId/call', async (c) => {
    const principal = await requireScope(c, 'memory:write');
    const projectId = c.req.param('projectId');
    const serverId = c.req.param('serverId');
    const body = await c.req.json();
    const result = await runtime.mcp.callTool({ serverId, toolName: body.toolName, args: body.args, owner: principal.id, taskId: body.taskId, approvalId: body.approvalId });
    const span = runtime.telemetry.startSpan({ kind: 'tool', name: `mcp-${body.toolName}`, projectId, taskId: body.taskId });
    runtime.telemetry.endSpan(span.spanId, 'ok');
    return c.json(result, 200);
  });

  // --- E7-S2 A2A task adapter ---
  router.get('/a2a/compatibility', async (c) => {
    await requireScope(c, 'memory:read');
    return c.json(runtime.a2a.getCompatibilityMatrix(), 200);
  });

  router.post('/a2a/cards', async (c) => {
    await requireScope(c, 'brain:admin');
    const body = await c.req.json();
    return c.json(await runtime.a2a.registerAgentCard(body), 201);
  });

  router.get('/a2a/cards', async (c) => {
    await requireScope(c, 'memory:read');
    return c.json({ cards: await runtime.a2a.listAgentCards() }, 200);
  });

  router.post('/projects/:projectId/a2a/delegate', async (c) => {
    const principal = await requireScope(c, 'memory:write');
    const projectId = c.req.param('projectId');
    const body = await c.req.json();
    const task = await runtime.a2a.delegateTask({ localTaskId: body.localTaskId, localStepId: body.localStepId, agentCardId: body.agentCardId, owner: principal.id, approvalId: body.approvalId, contextId: body.contextId });
    const span = runtime.telemetry.startSpan({ kind: 'tool', name: `a2a-delegate-${body.agentCardId}`, projectId, taskId: body.localTaskId });
    runtime.telemetry.endSpan(span.spanId, 'ok');
    return c.json(task, 201);
  });

  router.get('/projects/:projectId/a2a/tasks/:a2aTaskId', async (c) => {
    await requireScope(c, 'memory:read');
    return c.json(await runtime.a2a.getRemoteStatus(c.req.param('a2aTaskId')), 200);
  });

  router.post('/projects/:projectId/a2a/tasks/:a2aTaskId/status', async (c) => {
    await requireScope(c, 'memory:write');
    const body = await c.req.json();
    return c.json(await runtime.a2a.updateRemoteStatus(c.req.param('a2aTaskId'), body.status, body.artifacts), 200);
  });

  router.post('/projects/:projectId/a2a/tasks/:a2aTaskId/promote', async (c) => {
    const principal = await requireScope(c, 'memory:write');
    const body = await c.req.json();
    return c.json(await runtime.a2a.promoteArtifact({ a2aTaskId: c.req.param('a2aTaskId'), artifactId: body.artifactId, owner: principal.id, approvalId: body.approvalId }), 200);
  });

  router.get('/projects/:projectId/a2a/local/:localTaskId', async (c) => {
    await requireScope(c, 'memory:read');
    return c.json({ tasks: await runtime.a2a.listForLocalTask(c.req.param('localTaskId')) }, 200);
  });

  // --- E7-S3 Explicit one-project sync ---
  router.get('/projects/:projectId/sync/state', async (c) => {
    await requireScope(c, 'memory:read');
    return c.json(await runtime.sync.getState(c.req.param('projectId')), 200);
  });

  router.post('/projects/:projectId/sync/push', async (c) => {
    await requireScope(c, 'memory:write');
    const projectId = c.req.param('projectId');
    const body = await c.req.json();
    const result = await runtime.sync.push(projectId, body.changes ?? []);
    const span = runtime.telemetry.startSpan({ kind: 'task', name: `sync-push-${projectId}`, projectId });
    runtime.telemetry.endSpan(span.spanId, result.conflicts.length ? 'error' : 'ok');
    return c.json(result, 200);
  });

  router.get('/projects/:projectId/sync/pull', async (c) => {
    await requireScope(c, 'memory:read');
    const projectId = c.req.param('projectId');
    const after = Number(c.req.query('afterRevision') ?? -1);
    return c.json(await runtime.sync.pull(projectId, after), 200);
  });

  router.get('/projects/:projectId/sync/conflicts', async (c) => {
    await requireScope(c, 'memory:read');
    return c.json({ conflicts: await runtime.sync.listConflicts(c.req.param('projectId')) }, 200);
  });

  router.post('/projects/:projectId/sync/conflicts/:conflictId/resolve', async (c) => {
    const principal = await requireScope(c, 'memory:write');
    const projectId = c.req.param('projectId');
    const conflictId = c.req.param('conflictId');
    const body = await c.req.json();
    return c.json(await runtime.sync.resolveConflict(projectId, conflictId, body.resolution, principal.id, body.mergedPayload), 200);
  });

  router.get('/projects/:projectId/sync/pending', async (c) => {
    await requireScope(c, 'memory:read');
    return c.json({ pending: await runtime.sync.getPendingLocalChanges(c.req.param('projectId')) }, 200);
  });

  return router;
}
