/**
 * Task consolidation: turn finished work into durable, attributable memory.
 *
 * This closes the loop that context packs depend on. A completed task is
 * evidence that something is now true; without consolidation the next session
 * starts from zero again. The service is deliberately narrow:
 *
 *  1. Only completed tasks may be consolidated.
 *  2. Every memory is backed by project evidence, never bare assertion.
 *  3. Caller-supplied statements (what the agent actually learned) are
 *     accepted, typed and confidence-scored.
 *  4. Duplicate and near-duplicate memories are reported, not silently written.
 *  5. Low-confidence statements are stored as `candidate`, not `active`.
 *  6. Re-running is safe: the same task does not grow the memory store.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { MemoryRecord, R1Repositories } from './repositories.js';
import { R1Service } from './r1-services.js';
import type { Evidence, MemoryLifecycle } from './r1-types.js';

export type ConsolidationStatementType =
  'fact' | 'decision' | 'preference' | 'instruction' | 'summary';

export interface ConsolidationStatement {
  readonly text: string;
  readonly type?: ConsolidationStatementType;
  /** Defaults to 0.8; values below the threshold are stored as `candidate`. */
  readonly confidence?: number;
}

export interface ConsolidateTaskInput {
  readonly statements?: readonly ConsolidationStatement[];
  readonly agentId?: string;
  /** Minimum confidence for `active`; below this a memory is stored `candidate`. */
  readonly confidenceThreshold?: number;
  /** Hard cap on caller statements; extra statements are reported as skipped. */
  readonly maxStatements?: number;
}

export interface ConsolidationDuplicate {
  readonly text: string;
  readonly memoryId: string;
  readonly similarity: number;
}

export interface ConsolidationSkipped {
  readonly text: string;
  readonly reason: 'empty' | 'too_long' | 'over_limit' | 'duplicate_in_batch';
}

export interface ConsolidationResult {
  readonly projectId: string;
  readonly taskId: string;
  readonly generatedAt: string;
  readonly evidenceIds: readonly string[];
  readonly created: readonly {
    readonly id: string;
    readonly text: string;
    readonly lifecycle: MemoryLifecycle;
  }[];
  readonly duplicates: readonly ConsolidationDuplicate[];
  readonly skipped: readonly ConsolidationSkipped[];
}

export class ConsolidationError extends Error {
  constructor(
    public readonly code: 'TASK_NOT_FOUND' | 'TASK_NOT_COMPLETED' | 'PROJECT_NOT_FOUND',
    message: string
  ) {
    super(message);
    this.name = 'ConsolidationError';
    Object.setPrototypeOf(this, ConsolidationError.prototype);
  }
}

const STATEMENT_TYPES = new Set<ConsolidationStatementType>([
  'fact',
  'decision',
  'preference',
  'instruction',
  'summary',
]);

const MAX_STATEMENT_CHARS = 2_000;
const NEAR_DUPLICATE_THRESHOLD = 0.9;

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function tokenSet(text: string): Set<string> {
  return new Set(normalize(text).split(' ').filter(Boolean));
}

function similarity(a: string, b: string): number {
  const left = tokenSet(a);
  const right = tokenSet(b);
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

function clampConfidence(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

export class TaskConsolidationService {
  private readonly now: () => string;
  private readonly service: R1Service;

  constructor(
    private readonly repositories: R1Repositories,
    options: { now?: () => string } = {}
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.service = new R1Service(repositories, { now: this.now });
  }

  async consolidateTask(
    projectId: string,
    taskId: string,
    input: ConsolidateTaskInput = {}
  ): Promise<ConsolidationResult> {
    const project = await this.repositories.projects.get(projectId);
    if (!project) throw new ConsolidationError('PROJECT_NOT_FOUND', 'Project not found.');
    const task = await this.repositories.tasks.get(projectId, taskId);
    if (!task) throw new ConsolidationError('TASK_NOT_FOUND', 'Task not found.');
    if (task.state !== 'completed') {
      throw new ConsolidationError(
        'TASK_NOT_COMPLETED',
        'Only completed tasks can be consolidated.'
      );
    }

    const events = await this.repositories.tasks.listEvents(projectId, taskId);
    const completion = events.find((event) => event.event === 'complete');
    const evidence = await this.ensureEvidence(projectId, taskId, task.title, completion?.id);
    const generatedAt = this.now();

    const threshold = clampConfidence(input.confidenceThreshold, 0.7);
    const maxStatements = Math.max(1, Math.min(input.maxStatements ?? 20, 50));

    const proposed: { text: string; type: ConsolidationStatementType; confidence: number }[] = [
      {
        text: `Task "${task.title}" completed${task.goal ? `; goal: ${task.goal}` : ''}.`,
        type: 'fact',
        confidence: 0.9,
      },
    ];
    const skipped: ConsolidationSkipped[] = [];
    const statements = input.statements ?? [];
    let acceptedStatements = 0;
    for (const statement of statements) {
      const text = statement.text.trim();
      if (!text) {
        skipped.push({ text, reason: 'empty' });
        continue;
      }
      if (text.length > MAX_STATEMENT_CHARS) {
        skipped.push({ text: text.slice(0, 120), reason: 'too_long' });
        continue;
      }
      if (acceptedStatements >= maxStatements) {
        skipped.push({ text, reason: 'over_limit' });
        continue;
      }
      acceptedStatements += 1;
      const type = statement.type && STATEMENT_TYPES.has(statement.type) ? statement.type : 'fact';
      proposed.push({ text, type, confidence: clampConfidence(statement.confidence, 0.8) });
    }

    const existing: MemoryRecord[] = [...(await this.repositories.memories.list(projectId))];
    const duplicates: ConsolidationDuplicate[] = [];
    const created: ConsolidationResult['created'][number][] = [];
    const batchKeys = new Set<string>();

    for (const candidate of proposed) {
      const key = normalize(candidate.text);
      if (batchKeys.has(key)) {
        skipped.push({ text: candidate.text, reason: 'duplicate_in_batch' });
        continue;
      }
      batchKeys.add(key);

      let duplicate: ConsolidationDuplicate | null = null;
      for (const memory of existing) {
        const score = similarity(candidate.text, memory.content);
        if (normalize(memory.content) === key || score >= NEAR_DUPLICATE_THRESHOLD) {
          duplicate = { text: candidate.text, memoryId: memory.id, similarity: score };
          break;
        }
      }
      if (duplicate) {
        duplicates.push(duplicate);
        continue;
      }

      const lifecycle: MemoryLifecycle = candidate.confidence >= threshold ? 'active' : 'candidate';
      const memoryId = randomUUID();
      const record: MemoryRecord = {
        id: memoryId,
        projectId,
        content: candidate.text,
        metadata: {
          provenance: {
            type: candidate.type,
            source: 'task-consolidation',
            confidence: candidate.confidence,
            lifecycle,
            ...(input.agentId ? { agentId: input.agentId } : {}),
            evidenceIds: [evidence.id],
          },
          consolidation: { taskId, statementKey: sha256Hex(key), generatedAt },
        },
        evidenceIds: [evidence.id],
        createdAt: generatedAt,
        updatedAt: generatedAt,
      };
      await this.service.saveProvenanceMemory(record);
      existing.push(record);
      created.push({ id: memoryId, text: candidate.text, lifecycle });
    }

    return {
      projectId,
      taskId,
      generatedAt,
      evidenceIds: [evidence.id],
      created,
      duplicates,
      skipped,
    };
  }

  /**
   * Reuse existing task evidence when present; otherwise append one trace record
   * whose hash covers the completion fact so the memory is never unsupported.
   */
  private async ensureEvidence(
    projectId: string,
    taskId: string,
    title: string,
    completionEventId: string | undefined
  ): Promise<Evidence> {
    const existing = await this.repositories.evidence.listForTask(projectId, taskId);
    if (existing.length > 0) return existing[existing.length - 1] as Evidence;

    const payload = { projectId, taskId, state: 'completed' as const, title, completionEventId };
    const evidence: Evidence = {
      id: randomUUID(),
      projectId,
      taskId,
      kind: 'trace',
      source: 'task-consolidation',
      contentHash: sha256Hex(JSON.stringify(payload)),
      metadata: payload,
      createdAt: this.now(),
    };
    return this.repositories.evidence.append(evidence);
  }
}
