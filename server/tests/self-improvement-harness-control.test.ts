/**
 * Self-improvement harness control-plane tests: applyPatch live runtime-loop tuning +
 * risk/class/allowlist refusal, plus measureAndFinalize rollout decision.
 * Mocks DB, audit, logging, and Forge's public setters.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { findFirst, findMany } = vi.hoisted(() => ({
  findFirst: vi.fn(),
  findMany: vi.fn(),
}));
const updateSet = vi.fn();
const setSchedulingPolicy = vi.fn();
const configureWorker = vi.fn();

vi.mock('../src/db/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/db/client.js')>();
  return {
    ...actual,
    // These are isolated unit fixtures; the row payload below is deliberately
    // serialized as SQLite-style JSON regardless of the CI database service.
    isSqlite: true,
    db: {
      ...actual.db,
      query: {
        improvementProposals: { findFirst },
        metricSnapshots: { findMany },
      },
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 'p1' }]) }),
      }),
      update: vi.fn().mockImplementation(() => ({
        set: (obj: any) => {
          updateSet(obj);
          return { where: vi.fn().mockResolvedValue(undefined) };
        },
      })),
    },
  };
});

vi.mock('../src/lib/audit.js', () => ({ appendAudit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../src/lib/logging.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../src/services/scheduler.js', () => ({
  setSchedulingPolicy: (...a: any[]) => setSchedulingPolicy(...a),
}));
vi.mock('../src/services/task-worker.js', () => ({
  configureWorker: (...a: any[]) => configureWorker(...a),
}));

import {
  applyPatch,
  measureAndFinalize,
  type ProposalPatch,
  type RiskClass,
  type ProposalStatus,
} from '../src/services/self-improvement-harness.js';

function setProposal(
  patch: ProposalPatch,
  risk: RiskClass = 'ADVISORY',
  status: ProposalStatus = 'testing'
) {
  findFirst.mockResolvedValue({
    id: 'p1',
    riskClass: risk,
    status,
    patch: JSON.stringify(patch),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    decidedAt: null,
  });
}

describe('harness applyPatch — live runtime-loop tuning', () => {
  beforeEach(() => {
    setSchedulingPolicy.mockClear();
    configureWorker.mockClear();
    findFirst.mockReset();
    findMany.mockReset();
    updateSet.mockReset();
    process.env.NEXUS_SCHEDULER_POLICY = 'mlfq';
  });

  it('refuses BLOCKING risk class', async () => {
    setProposal({ kind: 'env', key: 'NEXUS_CACHE_TTL_MS', value: 5000 }, 'BLOCKING');
    const r = await applyPatch('p1');
    expect(r.applied).toBe(false);
    expect(r.reason).toContain('BLOCKING');
    expect(setSchedulingPolicy).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
  });

  it('refuses non-whitelisted env key', async () => {
    setProposal({ kind: 'env', key: 'NEXUS_SOME_SECRET', value: 'x' });
    const r = await applyPatch('p1');
    expect(r.applied).toBe(false);
    expect(r.reason).toContain('key_not_whitelisted');
    expect(updateSet).not.toHaveBeenCalled();
  });

  it('refuses when status is not testing/canary', async () => {
    setProposal({ kind: 'env', key: 'NEXUS_CACHE_TTL_MS', value: 5000 }, 'ADVISORY', 'draft');
    const r = await applyPatch('p1');
    expect(r.applied).toBe(false);
    expect(r.reason).toContain('invalid_status');
    expect(updateSet).not.toHaveBeenCalled();
  });

  it('applies whitelisted env override and tunes scheduler policy live', async () => {
    setProposal({ kind: 'env', key: 'NEXUS_SCHEDULER_POLICY', value: 'edf' });
    const r = await applyPatch('p1');
    expect(r.applied).toBe(true);
    expect(process.env.NEXUS_SCHEDULER_POLICY).toBe('edf');
    expect(setSchedulingPolicy).toHaveBeenCalledWith('edf');
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'canary', rolloutPct: 10 })
    );
  });

  it('applies whitelisted env override without a policy change call', async () => {
    setProposal({ kind: 'env', key: 'NEXUS_CACHE_TTL_MS', value: 5000 });
    const r = await applyPatch('p1');
    expect(r.applied).toBe(true);
    expect(setSchedulingPolicy).not.toHaveBeenCalled();
    expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({ status: 'canary' }));
  });

  it('applies pool_size patch by calling configureWorker (clamped)', async () => {
    setProposal({ kind: 'pool_size', key: 'worker_pool', value: 20 });
    const r = await applyPatch('p1');
    expect(r.applied).toBe(true);
    expect(configureWorker).toHaveBeenCalledWith({ maxConcurrency: 20 });
    expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({ status: 'canary' }));
  });
});

describe('harness measureAndFinalize', () => {
  beforeEach(() => {
    findFirst.mockReset();
    findMany.mockReset();
    updateSet.mockReset();
  });

  function baseProposal(baselineValue: number) {
    return {
      id: 'p1',
      riskClass: 'ADVISORY' as RiskClass,
      status: 'canary' as ProposalStatus,
      targetMetric: 'queue_wait_ms',
      baselineValue,
      patch: JSON.stringify({ kind: 'env', key: 'NEXUS_CACHE_TTL_MS', value: 1 }),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      decidedAt: null,
    };
  }

  it('rolls out when the metric improved after the canary window', async () => {
    findFirst.mockResolvedValue(baseProposal(200));
    findMany.mockResolvedValue([
      { value: 120, capturedAt: new Date() },
      { value: 130, capturedAt: new Date() },
    ]);
    const rec = await measureAndFinalize('p1');
    expect(rec).toBeTruthy();
    expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({ status: 'rolled_out' }));
    const call = updateSet.mock.calls[0]?.[0];
    expect(call.measuredDelta).toBeLessThan(0);
  });

  it('reverts when the metric regressed', async () => {
    findFirst.mockResolvedValue(baseProposal(100));
    findMany.mockResolvedValue([
      { value: 300, capturedAt: new Date() },
      { value: 320, capturedAt: new Date() },
    ]);
    const rec = await measureAndFinalize('p1');
    expect(rec).toBeTruthy();
    expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({ status: 'reverted' }));
    const call = updateSet.mock.calls[0]?.[0];
    expect(call.measuredDelta).toBeGreaterThan(0);
  });
});
