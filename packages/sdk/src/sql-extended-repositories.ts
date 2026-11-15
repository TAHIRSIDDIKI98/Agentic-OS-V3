/**
 * SQL implementations for extended R1 repositories (E2-S3, E3-S2, S3, E4-S4, etc.)
 * Uses same SqlExecutor pattern as sql-repositories.ts
 */

import type { SqlExecutor } from './sql-repositories.js';
import type { Checkpoint, TaskLease, CompensationStep } from './r1-task-worker.js';
import type { RecallFeedback, ContradictionSignal, FeedbackRepository, ContradictionRepository } from './r1-feedback.js';
import type { KillSwitchRepository, KillSwitchState, QuarantineState } from './r1-kill-switch.js';
import type { DurableApprovalRequest, ApprovalRepositoryEx } from './r1-approvals.js';
import type { CheckpointRepository, LeaseRepository, CompensationRepository } from './r1-task-worker.js';
import type { TelemetrySpan } from './r1-telemetry.js';

function one<T>(rows: readonly T[]): T | null { return rows[0] ?? null; }
function isoFromRow(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return String(value);
}
function jsonParse(value: unknown, fallback: unknown = {}): any {
  if (typeof value !== 'string') return value ?? fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

// Checkpoints
export class SqlCheckpoints implements CheckpointRepository {
  constructor(private readonly sql: SqlExecutor) {}
  async save(cp: Checkpoint): Promise<Checkpoint> {
    const row = one(await this.sql.query<Checkpoint>(`INSERT INTO r1_checkpoints (id, project_id, task_id, step_id, sequence, state_snapshot, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, project_id AS "projectId", task_id AS "taskId", step_id AS "stepId", sequence, state_snapshot AS "stateSnapshot", created_at AS "createdAt"`,
      [cp.id, cp.projectId, cp.taskId, cp.stepId ?? null, cp.sequence, JSON.stringify(cp.stateSnapshot), cp.createdAt]));
    if (!row) throw new Error('Checkpoint save failed');
    return {
      ...row,
      stateSnapshot: jsonParse((row as any).stateSnapshot),
      createdAt: isoFromRow((row as any).createdAt),
    } as Checkpoint;
  }
  async listForTask(projectId: string, taskId: string): Promise<readonly Checkpoint[]> {
    const rows = await this.sql.query<any>(`SELECT id, project_id AS "projectId", task_id AS "taskId", step_id AS "stepId", sequence, state_snapshot AS "stateSnapshot", created_at AS "createdAt" FROM r1_checkpoints WHERE project_id=$1 AND task_id=$2 ORDER BY sequence`, [projectId, taskId]);
    return rows.map((r) => ({ ...r, stateSnapshot: jsonParse(r.stateSnapshot), createdAt: isoFromRow(r.createdAt), stepId: r.stepId ?? undefined } as Checkpoint));
  }
  async getLatest(projectId: string, taskId: string): Promise<Checkpoint | null> {
    const rows = await this.sql.query<any>(`SELECT id, project_id AS "projectId", task_id AS "taskId", step_id AS "stepId", sequence, state_snapshot AS "stateSnapshot", created_at AS "createdAt" FROM r1_checkpoints WHERE project_id=$1 AND task_id=$2 ORDER BY sequence DESC LIMIT 1`, [projectId, taskId]);
    const r = one(rows);
    if (!r) return null;
    return { ...r, stateSnapshot: jsonParse(r.stateSnapshot), createdAt: isoFromRow(r.createdAt), stepId: r.stepId ?? undefined } as Checkpoint;
  }
}

// Leases
export class SqlLeases implements LeaseRepository {
  constructor(private readonly sql: SqlExecutor) {}
  async claim(projectId: string, taskId: string, owner: string, ttlMs: number): Promise<TaskLease | null> {
    const now = new Date();
    const expires = new Date(now.getTime() + ttlMs);
    try {
      const row = one(await this.sql.query<any>(`INSERT INTO r1_leases (task_id, project_id, owner, expires_at, heartbeat_at, version)
        VALUES ($1,$2,$3,$4,$5,1)
        ON CONFLICT (task_id) DO UPDATE SET owner=$3, expires_at=$4, heartbeat_at=$5, version=r1_leases.version+1
        WHERE r1_leases.expires_at <= $5
        RETURNING task_id AS "taskId", project_id AS "projectId", owner, expires_at AS "expiresAt", heartbeat_at AS "heartbeatAt", version`,
        [taskId, projectId, owner, expires.toISOString(), now.toISOString()]));
      if (!row) return null;
      return { taskId: row.taskId, projectId: row.projectId, owner: row.owner, expiresAt: isoFromRow(row.expiresAt), heartbeatAt: isoFromRow(row.heartbeatAt), version: row.version } as TaskLease;
    } catch { return null; }
  }
  async heartbeat(projectId: string, taskId: string, owner: string): Promise<TaskLease | null> {
    const now = new Date();
    const expires = new Date(now.getTime() + 30_000);
    const row = one(await this.sql.query<any>(`UPDATE r1_leases SET heartbeat_at=$4, expires_at=$5, version=version+1 WHERE task_id=$1 AND project_id=$2 AND owner=$3 RETURNING task_id AS "taskId", project_id AS "projectId", owner, expires_at AS "expiresAt", heartbeat_at AS "heartbeatAt", version`,
      [taskId, projectId, owner, now.toISOString(), expires.toISOString()]));
    if (!row) return null;
    return { taskId: row.taskId, projectId: row.projectId, owner: row.owner, expiresAt: isoFromRow(row.expiresAt), heartbeatAt: isoFromRow(row.heartbeatAt), version: row.version } as TaskLease;
  }
  async release(projectId: string, taskId: string, owner: string): Promise<void> {
    await this.sql.query(`DELETE FROM r1_leases WHERE task_id=$1 AND project_id=$2 AND owner=$3`, [taskId, projectId, owner]);
  }
  async listExpired(nowIso: string): Promise<readonly TaskLease[]> {
    const rows = await this.sql.query<any>(`SELECT task_id AS "taskId", project_id AS "projectId", owner, expires_at AS "expiresAt", heartbeat_at AS "heartbeatAt", version FROM r1_leases WHERE expires_at <= $1`, [nowIso]);
    return rows.map((r) => ({ taskId: r.taskId, projectId: r.projectId, owner: r.owner, expiresAt: isoFromRow(r.expiresAt), heartbeatAt: isoFromRow(r.heartbeatAt), version: r.version } as TaskLease));
  }
}

// Compensations
export class SqlCompensations implements CompensationRepository {
  constructor(private readonly sql: SqlExecutor) {}
  async save(c: CompensationStep): Promise<CompensationStep> {
    const row = one(await this.sql.query<any>(`INSERT INTO r1_compensations (id, project_id, task_id, target_step_id, reason, state, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, project_id AS "projectId", task_id AS "taskId", target_step_id AS "targetStepId", reason, state, created_at AS "createdAt"`,
      [c.id, c.projectId, c.taskId, c.targetStepId, c.reason, c.state, c.createdAt]));
    if (!row) throw new Error('Compensation save failed');
    return { id: row.id, projectId: row.projectId, taskId: row.taskId, targetStepId: row.targetStepId, reason: row.reason, state: row.state, createdAt: isoFromRow(row.createdAt) } as CompensationStep;
  }
  async listForTask(projectId: string, taskId: string): Promise<readonly CompensationStep[]> {
    const rows = await this.sql.query<any>(`SELECT id, project_id AS "projectId", task_id AS "taskId", target_step_id AS "targetStepId", reason, state, created_at AS "createdAt" FROM r1_compensations WHERE project_id=$1 AND task_id=$2 ORDER BY created_at`, [projectId, taskId]);
    return rows.map((r) => ({ id: r.id, projectId: r.projectId, taskId: r.taskId, targetStepId: r.targetStepId, reason: r.reason, state: r.state, createdAt: isoFromRow(r.createdAt) } as CompensationStep));
  }
  async listForProject(projectId: string): Promise<readonly CompensationStep[]> {
    const rows = await this.sql.query<any>(`SELECT id, project_id AS "projectId", task_id AS "taskId", target_step_id AS "targetStepId", reason, state, created_at AS "createdAt" FROM r1_compensations WHERE project_id=$1 ORDER BY created_at`, [projectId]);
    return rows.map((r) => ({ id: r.id, projectId: r.projectId, taskId: r.taskId, targetStepId: r.targetStepId, reason: r.reason, state: r.state, createdAt: isoFromRow(r.createdAt) } as CompensationStep));
  }
  async update(c: CompensationStep): Promise<CompensationStep> {
    const row = one(await this.sql.query<any>(`UPDATE r1_compensations SET state=$2 WHERE id=$1 AND project_id=$3 RETURNING id, project_id AS "projectId", task_id AS "taskId", target_step_id AS "targetStepId", reason, state, created_at AS "createdAt"`, [c.id, c.state, c.projectId]));
    if (!row) throw new Error('Compensation not found');
    return { id: row.id, projectId: row.projectId, taskId: row.taskId, targetStepId: row.targetStepId, reason: row.reason, state: row.state, createdAt: isoFromRow(row.createdAt) } as CompensationStep;
  }
}

// Feedback
export class SqlFeedback implements FeedbackRepository {
  constructor(private readonly sql: SqlExecutor) {}
  async save(fb: RecallFeedback): Promise<RecallFeedback> {
    const row = one(await this.sql.query<any>(`INSERT INTO r1_feedback (id, project_id, query, result_id, actor_id, helpful, comment, created_at, evidence_ids) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO UPDATE SET helpful=$6, comment=$7 RETURNING id, project_id AS "projectId", query, result_id AS "resultId", actor_id AS "actorId", helpful, comment, created_at AS "createdAt", evidence_ids AS "evidenceIds"`,
      [fb.id, fb.projectId, fb.query, fb.resultId, fb.actorId, fb.helpful ? 1 : 0, fb.comment ?? null, fb.createdAt, JSON.stringify(fb.evidenceIds ?? [])]));
    if (!row) throw new Error('Feedback save failed');
    return { id: row.id, projectId: row.projectId, query: row.query, resultId: row.resultId, actorId: row.actorId, helpful: row.helpful === 1 || row.helpful === true, comment: row.comment ?? undefined, createdAt: isoFromRow(row.createdAt), evidenceIds: jsonParse(row.evidenceIds ?? '[]') } as RecallFeedback;
  }
  async list(projectId: string, resultId?: string): Promise<readonly RecallFeedback[]> {
    const rows = resultId
      ? await this.sql.query<any>(`SELECT id, project_id AS "projectId", query, result_id AS "resultId", actor_id AS "actorId", helpful, comment, created_at AS "createdAt", evidence_ids AS "evidenceIds" FROM r1_feedback WHERE project_id=$1 AND result_id=$2 ORDER BY created_at`, [projectId, resultId])
      : await this.sql.query<any>(`SELECT id, project_id AS "projectId", query, result_id AS "resultId", actor_id AS "actorId", helpful, comment, created_at AS "createdAt", evidence_ids AS "evidenceIds" FROM r1_feedback WHERE project_id=$1 ORDER BY created_at`, [projectId]);
    return rows.map((r) => ({ id: r.id, projectId: r.projectId, query: r.query, resultId: r.resultId, actorId: r.actorId, helpful: r.helpful === 1 || r.helpful === true, comment: r.comment ?? undefined, createdAt: isoFromRow(r.createdAt), evidenceIds: jsonParse(r.evidenceIds ?? '[]') } as RecallFeedback));
  }
  async get(projectId: string, feedbackId: string): Promise<RecallFeedback | null> {
    const row = one(await this.sql.query<any>(`SELECT id, project_id AS "projectId", query, result_id AS "resultId", actor_id AS "actorId", helpful, comment, created_at AS "createdAt", evidence_ids AS "evidenceIds" FROM r1_feedback WHERE id=$1 AND project_id=$2`, [feedbackId, projectId]));
    if (!row) return null;
    return { id: row.id, projectId: row.projectId, query: row.query, resultId: row.resultId, actorId: row.actorId, helpful: row.helpful === 1 || row.helpful === true, comment: row.comment ?? undefined, createdAt: isoFromRow(row.createdAt), evidenceIds: jsonParse(row.evidenceIds ?? '[]') } as RecallFeedback;
  }
}

export class SqlContradiction implements ContradictionRepository {
  constructor(private readonly sql: SqlExecutor) {}
  async save(s: ContradictionSignal): Promise<ContradictionSignal> {
    const row = one(await this.sql.query<any>(`INSERT INTO r1_contradictions (id, project_id, memory_a_id, memory_b_id, reason, confidence, evidence_ids, status, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, project_id AS "projectId", memory_a_id AS "memoryAId", memory_b_id AS "memoryBId", reason, confidence, evidence_ids AS "evidenceIds", status, created_at AS "createdAt"`,
      [s.id, s.projectId, s.memoryAId, s.memoryBId, s.reason, s.confidence, JSON.stringify(s.evidenceIds), s.status, s.createdAt]));
    if (!row) throw new Error('Contradiction save failed');
    return { id: row.id, projectId: row.projectId, memoryAId: row.memoryAId, memoryBId: row.memoryBId, reason: row.reason, confidence: row.confidence, evidenceIds: jsonParse(row.evidenceIds), status: row.status, createdAt: isoFromRow(row.createdAt) } as ContradictionSignal;
  }
  async list(projectId: string): Promise<readonly ContradictionSignal[]> {
    const rows = await this.sql.query<any>(`SELECT id, project_id AS "projectId", memory_a_id AS "memoryAId", memory_b_id AS "memoryBId", reason, confidence, evidence_ids AS "evidenceIds", status, created_at AS "createdAt" FROM r1_contradictions WHERE project_id=$1 ORDER BY created_at`, [projectId]);
    return rows.map((r) => ({ id: r.id, projectId: r.projectId, memoryAId: r.memoryAId, memoryBId: r.memoryBId, reason: r.reason, confidence: r.confidence, evidenceIds: jsonParse(r.evidenceIds), status: r.status, createdAt: isoFromRow(r.createdAt) } as ContradictionSignal));
  }
  async listForMemory(projectId: string, memoryId: string): Promise<readonly ContradictionSignal[]> {
    const rows = await this.sql.query<any>(`SELECT id, project_id AS "projectId", memory_a_id AS "memoryAId", memory_b_id AS "memoryBId", reason, confidence, evidence_ids AS "evidenceIds", status, created_at AS "createdAt" FROM r1_contradictions WHERE project_id=$1 AND (memory_a_id=$2 OR memory_b_id=$2)`, [projectId, memoryId]);
    return rows.map((r) => ({ id: r.id, projectId: r.projectId, memoryAId: r.memoryAId, memoryBId: r.memoryBId, reason: r.reason, confidence: r.confidence, evidenceIds: jsonParse(r.evidenceIds), status: r.status, createdAt: isoFromRow(r.createdAt) } as ContradictionSignal));
  }
  async update(s: ContradictionSignal): Promise<ContradictionSignal> {
    const row = one(await this.sql.query<any>(`UPDATE r1_contradictions SET status=$2, reason=$3 WHERE id=$1 AND project_id=$4 RETURNING id, project_id AS "projectId", memory_a_id AS "memoryAId", memory_b_id AS "memoryBId", reason, confidence, evidence_ids AS "evidenceIds", status, created_at AS "createdAt"`, [s.id, s.status, s.reason, s.projectId]));
    if (!row) throw new Error('Contradiction not found');
    return { id: row.id, projectId: row.projectId, memoryAId: row.memoryAId, memoryBId: row.memoryBId, reason: row.reason, confidence: row.confidence, evidenceIds: jsonParse(row.evidenceIds), status: row.status, createdAt: isoFromRow(row.createdAt) } as ContradictionSignal;
  }
}

// Kill switch
export class SqlKillSwitch implements KillSwitchRepository {
  constructor(private readonly sql: SqlExecutor) {}
  async get(): Promise<KillSwitchState | null> {
    const row = one(await this.sql.query<any>(`SELECT id, enabled, reason, scope, enabled_by AS "enabledBy", enabled_at AS "enabledAt", disabled_by AS "disabledBy", disabled_at AS "disabledAt" FROM r1_kill_switch WHERE id='global'`));
    if (!row) return null;
    return {
      id: row.id, enabled: row.enabled === 1 || row.enabled === true, reason: row.reason, scope: jsonParse(row.scope), enabledBy: row.enabledBy, enabledAt: isoFromRow(row.enabledAt), disabledBy: row.disabledBy ?? undefined, disabledAt: row.disabledAt ? isoFromRow(row.disabledAt) : undefined,
    } as KillSwitchState;
  }
  async save(state: KillSwitchState): Promise<KillSwitchState> {
    const row = one(await this.sql.query<any>(`INSERT INTO r1_kill_switch (id, enabled, reason, scope, enabled_by, enabled_at, disabled_by, disabled_at) VALUES ('global',$1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO UPDATE SET enabled=$1, reason=$2, scope=$3, enabled_by=$4, enabled_at=$5, disabled_by=$6, disabled_at=$7 RETURNING id, enabled, reason, scope, enabled_by AS "enabledBy", enabled_at AS "enabledAt", disabled_by AS "disabledBy", disabled_at AS "disabledAt"`,
      [state.enabled ? 1 : 0, state.reason, JSON.stringify(state.scope), state.enabledBy, state.enabledAt, state.disabledBy ?? null, state.disabledAt ?? null]));
    if (!row) throw new Error('Kill switch save failed');
    return {
      id: row.id, enabled: row.enabled === 1 || row.enabled === true, reason: row.reason, scope: jsonParse(row.scope), enabledBy: row.enabledBy, enabledAt: isoFromRow(row.enabledAt), disabledBy: row.disabledBy ?? undefined, disabledAt: row.disabledAt ? isoFromRow(row.disabledAt) : undefined,
    } as KillSwitchState;
  }
  async listQuarantined(projectId?: string): Promise<readonly QuarantineState[]> {
    const rows = projectId
      ? await this.sql.query<any>(`SELECT project_id AS "projectId", task_id AS "taskId", reason, quarantined_at AS "quarantinedAt", quarantined_by AS "quarantinedBy" FROM r1_quarantine WHERE project_id=$1`, [projectId])
      : await this.sql.query<any>(`SELECT project_id AS "projectId", task_id AS "taskId", reason, quarantined_at AS "quarantinedAt", quarantined_by AS "quarantinedBy" FROM r1_quarantine`);
    return rows.map((r) => ({ projectId: r.projectId, taskId: r.taskId, reason: r.reason, quarantinedAt: isoFromRow(r.quarantinedAt), quarantinedBy: r.quarantinedBy } as QuarantineState));
  }
  async quarantine(state: QuarantineState): Promise<QuarantineState> {
    const row = one(await this.sql.query<any>(`INSERT INTO r1_quarantine (project_id, task_id, reason, quarantined_at, quarantined_by) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (project_id, task_id) DO UPDATE SET reason=$3, quarantined_at=$4, quarantined_by=$5 RETURNING project_id AS "projectId", task_id AS "taskId", reason, quarantined_at AS "quarantinedAt", quarantined_by AS "quarantinedBy"`,
      [state.projectId, state.taskId, state.reason, state.quarantinedAt, state.quarantinedBy]));
    if (!row) throw new Error('Quarantine failed');
    return { projectId: row.projectId, taskId: row.taskId, reason: row.reason, quarantinedAt: isoFromRow(row.quarantinedAt), quarantinedBy: row.quarantinedBy } as QuarantineState;
  }
  async releaseQuarantine(projectId: string, taskId: string): Promise<void> {
    await this.sql.query(`DELETE FROM r1_quarantine WHERE project_id=$1 AND task_id=$2`, [projectId, taskId]);
  }
}

// Durable approvals
export class SqlDurableApprovals implements ApprovalRepositoryEx {
  constructor(private readonly sql: SqlExecutor) {}
  async get(projectId: string, approvalId: string): Promise<DurableApprovalRequest | null> {
    const row = one(await this.sql.query<any>(`SELECT id, project_id AS "projectId", task_id AS "taskId", capability_id AS "capabilityId", state, action, created_at AS "createdAt", updated_at AS "updatedAt", decision_actor_id AS "decisionActorId", decision_at AS "decisionAt" FROM r1_durable_approvals WHERE id=$1 AND project_id=$2`, [approvalId, projectId]));
    if (!row) return null;
    return {
      id: row.id, projectId: row.projectId, taskId: row.taskId, capabilityId: row.capabilityId, state: row.state,
      action: jsonParse(row.action), createdAt: isoFromRow(row.createdAt), updatedAt: isoFromRow(row.updatedAt),
      decisionActorId: row.decisionActorId ?? undefined, decisionAt: row.decisionAt ? isoFromRow(row.decisionAt) : undefined,
    } as DurableApprovalRequest;
  }
  async listPending(projectId: string): Promise<readonly DurableApprovalRequest[]> {
    const rows = await this.sql.query<any>(`SELECT id, project_id AS "projectId", task_id AS "taskId", capability_id AS "capabilityId", state, action, created_at AS "createdAt", updated_at AS "updatedAt", decision_actor_id AS "decisionActorId", decision_at AS "decisionAt" FROM r1_durable_approvals WHERE project_id=$1 AND state='pending' ORDER BY created_at`, [projectId]);
    return rows.map((row) => ({
      id: row.id, projectId: row.projectId, taskId: row.taskId, capabilityId: row.capabilityId, state: row.state,
      action: jsonParse(row.action), createdAt: isoFromRow(row.createdAt), updatedAt: isoFromRow(row.updatedAt),
      decisionActorId: row.decisionActorId ?? undefined, decisionAt: row.decisionAt ? isoFromRow(row.decisionAt) : undefined,
    } as DurableApprovalRequest));
  }
  async listForProject(projectId: string): Promise<readonly DurableApprovalRequest[]> {
    const rows = await this.sql.query<any>(`SELECT id, project_id AS "projectId", task_id AS "taskId", capability_id AS "capabilityId", state, action, created_at AS "createdAt", updated_at AS "updatedAt", decision_actor_id AS "decisionActorId", decision_at AS "decisionAt" FROM r1_durable_approvals WHERE project_id=$1 ORDER BY created_at`, [projectId]);
    return rows.map((row) => ({
      id: row.id, projectId: row.projectId, taskId: row.taskId, capabilityId: row.capabilityId, state: row.state,
      action: jsonParse(row.action), createdAt: isoFromRow(row.createdAt), updatedAt: isoFromRow(row.updatedAt),
      decisionActorId: row.decisionActorId ?? undefined, decisionAt: row.decisionAt ? isoFromRow(row.decisionAt) : undefined,
    } as DurableApprovalRequest));
  }
  async create(req: DurableApprovalRequest): Promise<DurableApprovalRequest> {
    const row = one(await this.sql.query<any>(`INSERT INTO r1_durable_approvals (id, project_id, task_id, capability_id, state, action, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, project_id AS "projectId", task_id AS "taskId", capability_id AS "capabilityId", state, action, created_at AS "createdAt", updated_at AS "updatedAt"`,
      [req.id, req.projectId, req.taskId, req.capabilityId, req.state, JSON.stringify(req.action), req.createdAt, req.updatedAt]));
    if (!row) throw new Error('Approval create failed');
    return { id: row.id, projectId: row.projectId, taskId: row.taskId, capabilityId: row.capabilityId, state: row.state, action: jsonParse(row.action), createdAt: isoFromRow(row.createdAt), updatedAt: isoFromRow(row.updatedAt) } as DurableApprovalRequest;
  }
  async update(req: DurableApprovalRequest): Promise<DurableApprovalRequest> {
    const row = one(await this.sql.query<any>(`UPDATE r1_durable_approvals SET state=$2, updated_at=$3, decision_actor_id=$4, decision_at=$5 WHERE id=$1 AND project_id=$6 RETURNING id, project_id AS "projectId", task_id AS "taskId", capability_id AS "capabilityId", state, action, created_at AS "createdAt", updated_at AS "updatedAt", decision_actor_id AS "decisionActorId", decision_at AS "decisionAt"`,
      [req.id, req.state, req.updatedAt, req.decisionActorId ?? null, req.decisionAt ?? null, req.projectId]));
    if (!row) throw new Error('Approval not found');
    return {
      id: row.id, projectId: row.projectId, taskId: row.taskId, capabilityId: row.capabilityId, state: row.state,
      action: jsonParse(row.action), createdAt: isoFromRow(row.createdAt), updatedAt: isoFromRow(row.updatedAt),
      decisionActorId: row.decisionActorId ?? undefined, decisionAt: row.decisionAt ? isoFromRow(row.decisionAt) : undefined,
    } as DurableApprovalRequest;
  }
}

// Telemetry spans
export class SqlTelemetry {
  constructor(private readonly sql: SqlExecutor) {}
  async saveSpan(span: TelemetrySpan): Promise<void> {
    await this.sql.query(`INSERT INTO r1_telemetry_spans (span_id, trace_id, parent_span_id, kind, name, start_at, end_at, status, attributes, task_id, project_id, approval_id, receipt_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (span_id) DO UPDATE SET end_at=$7, status=$8, attributes=$9`,
      [span.spanId, span.traceId, span.parentSpanId ?? null, span.kind, span.name, span.startAt, span.endAt ?? null, span.status, JSON.stringify(span.attributes), span.taskId ?? null, span.projectId ?? null, span.approvalId ?? null, span.receiptId ?? null]);
  }
  async listForTask(projectId: string, taskId: string): Promise<readonly TelemetrySpan[]> {
    const rows = await this.sql.query<any>(`SELECT span_id AS "spanId", trace_id AS "traceId", parent_span_id AS "parentSpanId", kind, name, start_at AS "startAt", end_at AS "endAt", status, attributes, task_id AS "taskId", project_id AS "projectId" FROM r1_telemetry_spans WHERE project_id=$1 AND task_id=$2 ORDER BY start_at`, [projectId, taskId]);
    return rows.map((r) => ({ spanId: r.spanId, traceId: r.traceId, parentSpanId: r.parentSpanId ?? undefined, kind: r.kind, name: r.name, startAt: isoFromRow(r.startAt), endAt: r.endAt ? isoFromRow(r.endAt) : undefined, status: r.status, attributes: jsonParse(r.attributes), taskId: r.taskId ?? undefined, projectId: r.projectId ?? undefined } as TelemetrySpan));
  }
}
