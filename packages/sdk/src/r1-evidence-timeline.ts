/**
 * E5-S3 Evidence timeline and safe export
 * - Timeline joins task/step/approval/receipt/audit/trace/provenance via service projections
 * - Export includes schema version, scope, selected records, redaction summary, integrity metadata
 * - Export never includes secrets or auth headers
 * - Import dry-run reports additions/conflicts/rejections without mutation
 * - Export/import failures leave source unchanged
 */

import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import type { R1Repositories } from './repositories.js';
import type { Evidence, Task, ActionReceipt, TaskStep } from './r1-types.js';

export const TimelineEntryKindSchema = z.enum(['task', 'step', 'approval', 'receipt', 'evidence', 'checkpoint', 'feedback']);
export type TimelineEntryKind = z.infer<typeof TimelineEntryKindSchema>;

export const TimelineEntrySchema = z.object({
  id: z.string().min(1),
  kind: TimelineEntryKindSchema,
  projectId: z.string().uuid(),
  taskId: z.string().uuid().optional(),
  timestamp: z.string().datetime(),
  summary: z.string().max(2000),
  refIds: z.object({
    taskId: z.string().uuid().optional(),
    stepId: z.string().uuid().optional(),
    approvalId: z.string().uuid().optional(),
    receiptId: z.string().uuid().optional(),
    evidenceId: z.string().uuid().optional(),
    traceId: z.string().optional(),
  }).default({}),
  redacted: z.boolean().default(false),
});
export type TimelineEntry = z.infer<typeof TimelineEntrySchema>;

export const EvidenceExportSchema = z.object({
  schemaVersion: z.literal('r1.evidence-export.v1'),
  exportedAt: z.string().datetime(),
  projectId: z.string().uuid(),
  scope: z.object({
    taskIds: z.array(z.string().uuid()).optional(),
    includeApprovals: z.boolean().default(true),
    includeReceipts: z.boolean().default(true),
    includeEvidence: z.boolean().default(true),
    includeSteps: z.boolean().default(true),
  }),
  timeline: z.array(TimelineEntrySchema),
  tasks: z.array(z.record(z.string(), z.unknown())),
  steps: z.array(z.record(z.string(), z.unknown())),
  approvals: z.array(z.record(z.string(), z.unknown())),
  receipts: z.array(z.record(z.string(), z.unknown())),
  evidence: z.array(z.record(z.string(), z.unknown())),
  redactionSummary: z.object({
    redactedFields: z.array(z.string()),
    omittedSecrets: z.number(),
    totalRecords: z.number(),
  }),
  integrity: z.object({
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    recordCounts: z.record(z.string(), z.number()),
  }),
});
export type EvidenceExport = z.infer<typeof EvidenceExportSchema>;

function sha256Hex(canonical: string): string {
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(',')}}`;
}

function redactSecrets(obj: Record<string, unknown>): { redacted: Record<string, unknown>; redactedFields: string[]; omitted: number } {
  const secretPattern = /password|secret|token|api[_-]?key|authorization|credential|private[_-]?key|bearer/i;
  const redactedFields: string[] = [];
  let omitted = 0;
  const copy: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (secretPattern.test(k)) {
      redactedFields.push(k);
      omitted++;
      copy[k] = '[REDACTED]';
    } else if (typeof v === 'string' && secretPattern.test(v) && v.length > 20) {
      // Heuristic: long secret-like string values
      redactedFields.push(k);
      copy[k] = '[REDACTED]';
      omitted++;
    } else {
      copy[k] = v;
    }
  }
  return { redacted: copy, redactedFields, omitted };
}

export interface EvidenceTimelineOptions {
  readonly now?: () => string;
}

export class EvidenceTimelineService {
  private readonly now: () => string;
  constructor(private readonly repos: R1Repositories, options: EvidenceTimelineOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async buildTimeline(projectId: string, taskId?: string): Promise<readonly TimelineEntry[]> {
    const tasks = taskId ? [await this.repos.tasks.get(projectId, taskId)].filter(Boolean) as Task[] : await this.repos.tasks.list(projectId);
    const entries: TimelineEntry[] = [];

    for (const task of tasks) {
      entries.push({
        id: `task:${task.id}`,
        kind: 'task',
        projectId,
        taskId: task.id,
        timestamp: task.createdAt,
        summary: `Task ${task.title} (${task.state})`,
        refIds: { taskId: task.id },
        redacted: false,
      });

      const steps = await this.repos.tasks.listSteps(projectId, task.id);
      for (const step of steps) {
        entries.push({
          id: `step:${step.id}`,
          kind: 'step',
          projectId,
          taskId: task.id,
          timestamp: task.createdAt, // using task created as proxy unless step has timestamp
          summary: `Step ${step.sequence}: ${step.name} (${step.state})`,
          refIds: { taskId: task.id, stepId: step.id },
          redacted: false,
        });
      }

      const events = await this.repos.tasks.listEvents(projectId, task.id);
      for (const ev of events) {
        entries.push({
          id: `event:${ev.id}`,
          kind: 'task',
          projectId,
          taskId: task.id,
          timestamp: ev.createdAt,
          summary: `Event ${ev.event} -> ${ev.state} seq=${ev.sequence}`,
          refIds: { taskId: task.id, traceId: ev.id },
          redacted: false,
        });
      }

      const evidence = await this.repos.evidence.listForTask(projectId, task.id);
      for (const ev of evidence) {
        entries.push({
          id: `evidence:${ev.id}`,
          kind: 'evidence',
          projectId,
          taskId: task.id,
          timestamp: ev.createdAt,
          summary: `Evidence ${ev.kind} from ${ev.source}`,
          refIds: { taskId: task.id, evidenceId: ev.id },
          redacted: false,
        });
      }

      const receipts = await this.repos.receipts.listForTask(projectId, task.id);
      for (const r of receipts) {
        entries.push({
          id: `receipt:${r.id}`,
          kind: 'receipt',
          projectId,
          taskId: task.id,
          timestamp: r.createdAt,
          summary: `Receipt ${r.kind} actor=${r.actor} decision=${r.decision}`,
          refIds: { taskId: task.id, receiptId: r.id },
          redacted: true, // receipts are redacted summary
        });
      }
    }

    // approvals
    const approvals = await this.repos.approvals.listPending(projectId);
    for (const appr of approvals) {
      entries.push({
        id: `approval:${appr.id}`,
        kind: 'approval',
        projectId,
        taskId: appr.taskId,
        timestamp: appr.createdAt,
        summary: `Approval ${appr.id} for capability ${appr.capabilityId} (${appr.state})`,
        refIds: { taskId: appr.taskId, approvalId: appr.id },
        redacted: false,
      });
    }

    return entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  async exportEvidence(projectId: string, scope: EvidenceExport['scope'] = { includeApprovals: true, includeReceipts: true, includeEvidence: true, includeSteps: true }): Promise<EvidenceExport> {
    const project = await this.repos.projects.get(projectId);
    if (!project) throw new Error('Project not found');

    const timeline = await this.buildTimeline(projectId);
    const tasks = scope.taskIds?.length ? (await Promise.all(scope.taskIds.map((id) => this.repos.tasks.get(projectId, id)))).filter(Boolean) as Task[] : await this.repos.tasks.list(projectId);

    const allSteps: TaskStep[] = [];
    const allApprovals: any[] = [];
    const allReceipts: ActionReceipt[] = [];
    const allEvidence: Evidence[] = [];

    for (const task of tasks) {
      if (scope.includeSteps) allSteps.push(...(await this.repos.tasks.listSteps(projectId, task.id)));
      if (scope.includeEvidence) allEvidence.push(...(await this.repos.evidence.listForTask(projectId, task.id)));
      if (scope.includeReceipts) allReceipts.push(...(await this.repos.receipts.listForTask(projectId, task.id)));
    }
    if (scope.includeApprovals) {
      const pending = await this.repos.approvals.listPending(projectId);
      allApprovals.push(...pending);
    }

    // Redact secrets, never include raw secrets
    let totalRedactedFields: string[] = [];
    let totalOmitted = 0;
    const redactList = (list: Record<string, unknown>[]): Record<string, unknown>[] => {
      return list.map((item) => {
        const { redacted, redactedFields, omitted } = redactSecrets(item);
        totalRedactedFields.push(...redactedFields);
        totalOmitted += omitted;
        return redacted;
      });
    };

    const safeTasks = redactList(tasks as any);
    const safeSteps = redactList(allSteps as any);
    const safeApprovals = redactList(allApprovals as any);
    const safeReceipts = redactList(allReceipts as any);
    const safeEvidence = redactList(allEvidence as any);

    const payloadForHash = {
      projectId,
      tasks: safeTasks,
      steps: safeSteps,
      approvals: safeApprovals,
      receipts: safeReceipts,
      evidence: safeEvidence,
    };

    const contentHash = sha256Hex(canonicalJson(payloadForHash));

    return {
      schemaVersion: 'r1.evidence-export.v1',
      exportedAt: this.now(),
      projectId,
      scope,
      timeline: [...timeline],
      tasks: safeTasks,
      steps: safeSteps,
      approvals: safeApprovals,
      receipts: safeReceipts,
      evidence: safeEvidence,
      redactionSummary: {
        redactedFields: [...new Set(totalRedactedFields)],
        omittedSecrets: totalOmitted,
        totalRecords: safeTasks.length + safeSteps.length + safeApprovals.length + safeReceipts.length + safeEvidence.length,
      },
      integrity: {
        contentHash,
        recordCounts: {
          tasks: safeTasks.length,
          steps: safeSteps.length,
          approvals: safeApprovals.length,
          receipts: safeReceipts.length,
          evidence: safeEvidence.length,
          timeline: timeline.length,
        },
      },
    };
  }
}
