import { Hono } from 'hono';
import { z } from 'zod';
import { ok, err } from '../lib/envelope.js';
import { env } from '../lib/env.js';
import { log } from '../lib/logger.js';
import { selfOptController, SelfOptController } from '../services/self-opt/controller.js';
import {
  guardrailGuard,
  getGuardrailBounds,
  GuardrailGuard,
  GUARDRAIL_LEVELS,
} from '../services/self-opt/guardrail-guard.js';
import { ALL_TUNERS } from '../services/self-opt/tuners.js';
import { metricStore, readMetrics, exportMetric } from '../services/self-opt/telemetry.js';
import {
  powerCalculator,
  generateHypothesis,
  fairnessCheck,
  explorationBudgetStatus,
  costKillSwitch,
  metaOptimize,
  simulateCycle,
  createExperiment,
  finishExperiment,
  publishKnowledge,
  bestKnowledge,
  recordSatisfaction,
  type SimulateCandidate,
} from '../services/self-opt/gap-items.js';
import { ADAPTERS } from '../services/self-opt/adapters.js';
import { setSelfOptParam } from '../services/self-opt/bootstrap.js';

export const selfOptRouter = new Hono();

const liveFlag = (): boolean => env.NEXUS_SELF_OPT_LIVE_WRITE;

selfOptRouter.get('/state', (c) => {
  return c.json(
    ok({
      tuners: selfOptController.listTuners(),
      guardrails: getGuardrailBounds(),
      live: liveFlag(),
    })
  );
});

selfOptRouter.post('/cycle', async (c) => {
  try {
    const report = await selfOptController.runCycle();
    return c.json(ok(report));
  } catch (e) {
    return c.json(err('SELF_OPT_CYCLE_FAILED', e instanceof Error ? e.message : String(e)), 500);
  }
});

const liveWriteSchema = z.object({ enabled: z.boolean() });
selfOptRouter.post('/live-write', async (c) => {
  const parsed = liveWriteSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json(err('VALIDATION', 'enabled:boolean required'), 400);
  (env as Record<string, unknown>).NEXUS_SELF_OPT_LIVE_WRITE = parsed.data.enabled;
  log.info('self_opt_live_write_toggled', { enabled: parsed.data.enabled });
  return c.json(ok({ live: parsed.data.enabled }));
});

selfOptRouter.get('/metrics', (c) => {
  return c.json(ok({ metrics: readMetrics() }));
});

const simulateSchema = z.object({
  candidate: z.object({
    id: z.string(),
    name: z.string(),
    before: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])),
    after: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])),
    expectedEffect: z.string(),
    ownerAgent: z.string(),
    targetInterface: z.string(),
  }),
});
selfOptRouter.post('/simulate', async (c) => {
  const parsed = simulateSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json(err('VALIDATION', 'candidate required'), 400);
  const result = simulateCycle(parsed.data.candidate as SimulateCandidate, guardrailGuard);
  return c.json(ok(result));
});

const tuneSchema = z.object({ key: z.string(), value: z.number() });
selfOptRouter.post('/tune', async (c) => {
  const parsed = tuneSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json(err('VALIDATION', 'key:string, value:number required'), 400);
  const tuner = ALL_TUNERS.find((t) => t.id === parsed.data.key);
  if (!tuner) return c.json(err('UNKNOWN_TUNER', parsed.data.key), 404);
  // Persist intended value (real, durable) + apply via the adapter seam in live mode.
  await setSelfOptParam(`tuner.${tuner.id}`, parsed.data.value).catch(() => undefined);
  if (liveFlag()) {
    await tuner.adapter.apply({ value: parsed.data.value });
  }
  exportMetric(`self_opt_${tuner.id}_after`, parsed.data.value);
  metricStore.set(`self_opt_${tuner.id}_after`, parsed.data.value);
  return c.json(ok({ applied: liveFlag() }));
});

const experimentSchema = z.object({
  action: z.enum(['create', 'finish']),
  hypothesis: z.string().optional(),
  id: z.string().optional(),
});
selfOptRouter.post('/experiment', async (c) => {
  const parsed = experimentSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json(err('VALIDATION', parsed.error.message), 400);
  try {
    if (parsed.data.action === 'create') {
      const exp = createExperiment(parsed.data.hypothesis ?? '');
      return c.json(ok(exp));
    }
    if (!parsed.data.id) return c.json(err('VALIDATION', 'id required to finish'), 400);
    const exp = finishExperiment(parsed.data.id);
    return c.json(ok(exp));
  } catch (e) {
    return c.json(err('EXPERIMENT_FAILED', e instanceof Error ? e.message : String(e)), 500);
  }
});

const knowledgeSchema = z.object({
  action: z.enum(['publish', 'best']),
  tunerId: z.string(),
  payload: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).optional(),
  score: z.number().optional(),
});
selfOptRouter.post('/knowledge', async (c) => {
  const parsed = knowledgeSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json(err('VALIDATION', parsed.error.message), 400);
  try {
    if (parsed.data.action === 'publish') {
      const id = publishKnowledge(
        parsed.data.tunerId,
        (parsed.data.payload as Record<string, never>) ?? {},
        parsed.data.score ?? 0.5
      );
      return c.json(ok({ id }));
    }
    const best = bestKnowledge(parsed.data.tunerId);
    return c.json(ok(best));
  } catch (e) {
    return c.json(err('KNOWLEDGE_FAILED', e instanceof Error ? e.message : String(e)), 500);
  }
});

const satisfactionSchema = z.object({ agentId: z.string(), score: z.number().min(0).max(1) });
selfOptRouter.post('/satisfaction', async (c) => {
  const parsed = satisfactionSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json(err('VALIDATION', parsed.error.message), 400);
  const rec = recordSatisfaction(parsed.data.agentId, parsed.data.score);
  return c.json(ok(rec));
});

// Health probe for the meta-loop.
selfOptRouter.get('/health', (c) => {
  return c.json(ok({ live: liveFlag(), tuners: selfOptController.listTuners().length }));
});

export {
  SelfOptController,
  GuardrailGuard,
  GUARDRAIL_LEVELS,
  ADAPTERS,
  powerCalculator,
  generateHypothesis,
  fairnessCheck,
  explorationBudgetStatus,
  costKillSwitch,
  metaOptimize,
};
