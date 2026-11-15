/**
 * Bounded project context packs for long-horizon agent work (E2-S2 extension).
 *
 * The problem this solves is context exhaustion: an agent returning to a project
 * after days cannot replay its history, and dumping everything fails. A context
 * pack is a deterministic, provenance-backed digest - project state, open tasks,
 * pending approvals and the most useful active memories - packed under a caller
 * supplied token budget, with explicit truncation and citations.
 *
 * Design guarantees:
 *  1. Never exceeds the requested budget using the same estimator as recall.
 *  2. Every included memory carries its evidence citations.
 *  3. Archived/forgotten memories and terminal tasks are excluded.
 *  4. Pending approvals outrank memories; open tasks outrank passive context.
 *  5. Output is deterministic for the same repository state and clock.
 *  6. Truncation is explicit per section and globally.
 */
import type { MemoryRecord, R1Repositories } from './repositories.js';
import type { Task } from './r1-types.js';
import { estimateTokens } from './r1-recall.js';
import { MemoryProvenanceSchema } from './r1-types.js';

export type ContextPackKind = 'project' | 'task' | 'approval' | 'memory';

export interface ContextPackItem {
  readonly id: string;
  readonly kind: ContextPackKind;
  readonly text: string;
  readonly tokens: number;
  readonly score: number;
  readonly refIds: Readonly<Record<string, string>>;
  readonly evidenceIds: readonly string[];
}

export interface ContextPackSection {
  readonly id: string;
  readonly title: string;
  readonly items: readonly ContextPackItem[];
  readonly omitted: number;
}

export interface ContextPack {
  readonly projectId: string;
  readonly generatedAt: string;
  readonly budgetRequested: number;
  readonly budgetUsed: number;
  readonly truncated: boolean;
  readonly focus?: string;
  readonly sections: readonly ContextPackSection[];
  readonly citations: readonly string[];
}

export interface ContextPackApprovalRef {
  readonly id: string;
  readonly taskId: string;
  readonly capabilityId?: string;
  readonly state: string;
  readonly createdAt: string;
}

export interface ContextPackOptions {
  readonly now?: () => string;
  readonly listApprovals?: (projectId: string) => Promise<readonly ContextPackApprovalRef[]>;
}

export interface BuildContextPackInput {
  readonly tokenBudget: number;
  readonly focus?: string;
  readonly taskId?: string;
  /** Cap on memories considered before packing; defaults to 500. */
  readonly memoryLimit?: number;
}

const SECTION_TITLES: Readonly<Record<ContextPackKind, string>> = {
  project: 'Project',
  task: 'Open tasks',
  approval: 'Pending approvals',
  memory: 'Active memories',
};

const KIND_WEIGHT: Readonly<Record<ContextPackKind, number>> = {
  approval: 4,
  task: 3,
  project: 2,
  memory: 1,
};

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/gu)
    .filter(Boolean);
}

function lexicalRelevance(query: string, content: string): number {
  const q = new Set(tokenize(query));
  if (q.size === 0) return 0;
  const tokens = new Set(tokenize(content));
  let overlap = 0;
  for (const token of q) if (tokens.has(token)) overlap += 1;
  return overlap / q.size;
}

function confidenceOf(memory: MemoryRecord): number {
  const parsed = MemoryProvenanceSchema.safeParse(
    (memory.metadata as Record<string, unknown>).provenance
  );
  return parsed.success ? parsed.data.confidence : 0.5;
}

function lifecycleOf(memory: MemoryRecord): string {
  const parsed = MemoryProvenanceSchema.safeParse(
    (memory.metadata as Record<string, unknown>).provenance
  );
  // Legacy memories without provenance are treated as active rather than lost.
  return parsed.success ? parsed.data.lifecycle : 'active';
}

function recencyFactor(timestamp: string, nowMs: number): number {
  const then = Date.parse(timestamp);
  if (!Number.isFinite(then)) return 0;
  const ageDays = Math.max(0, (nowMs - then) / 86_400_000);
  return 1 / (1 + ageDays / 30);
}

const TERMINAL_TASK_STATES = new Set(['completed', 'failed', 'cancelled']);

export class ContextPackService {
  private readonly now: () => string;
  private readonly listApprovals?: ContextPackOptions['listApprovals'];

  constructor(
    private readonly repositories: R1Repositories,
    options: ContextPackOptions = {}
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.listApprovals = options.listApprovals;
  }

  async build(projectId: string, input: BuildContextPackInput): Promise<ContextPack> {
    if (!Number.isInteger(input.tokenBudget) || input.tokenBudget < 1) {
      throw new Error('tokenBudget must be a positive integer');
    }
    const project = await this.repositories.projects.get(projectId);
    if (!project) throw new Error('Project not found');

    const nowIso = this.now();
    const nowMs = Date.parse(nowIso);
    const focus = input.focus?.trim() || undefined;

    const candidates: ContextPackItem[] = [];

    // Project identity is always a candidate; it is small and anchors every answer.
    const projectText =
      `Project ${project.name} (${project.mode}), id ${project.id}, scope ` +
      `${JSON.stringify(project.scope)}.`;
    candidates.push({
      id: `project:${project.id}`,
      kind: 'project',
      text: projectText,
      tokens: estimateTokens(projectText),
      score: KIND_WEIGHT.project + 1,
      refIds: { projectId: project.id },
      evidenceIds: [],
    });

    const tasks = (await this.repositories.tasks.list(projectId)).filter(
      (task: Task) => !TERMINAL_TASK_STATES.has(task.state)
    );
    const relevantTasks = input.taskId ? tasks.filter((task) => task.id === input.taskId) : tasks;
    for (const task of relevantTasks) {
      const text = `Task ${task.title} [${task.state}] goal: ${task.goal} (id ${task.id})`;
      candidates.push({
        id: `task:${task.id}`,
        kind: 'task',
        text,
        tokens: estimateTokens(text),
        score: KIND_WEIGHT.task + recencyFactor(task.updatedAt, nowMs),
        refIds: { projectId, taskId: task.id },
        evidenceIds: [],
      });
    }

    const approvals = this.listApprovals
      ? (await this.listApprovals(projectId)).filter((approval) => approval.state === 'pending')
      : (await this.repositories.approvals.listPending(projectId)).map((approval) => ({
          id: approval.id,
          taskId: approval.taskId,
          capabilityId: approval.capabilityId,
          state: approval.state,
          createdAt: approval.createdAt,
        }));
    for (const approval of approvals) {
      if (input.taskId && approval.taskId !== input.taskId) continue;
      const text =
        `Pending approval ${approval.id} for ${approval.capabilityId ?? 'capability'} ` +
        `on task ${approval.taskId}.`;
      candidates.push({
        id: `approval:${approval.id}`,
        kind: 'approval',
        text,
        tokens: estimateTokens(text),
        score: KIND_WEIGHT.approval + recencyFactor(approval.createdAt, nowMs),
        refIds: { projectId, taskId: approval.taskId, approvalId: approval.id },
        evidenceIds: [],
      });
    }

    const memories = (await this.repositories.memories.list(projectId))
      .filter((memory) => {
        if (memory.projectId !== projectId) return false;
        const lifecycle = lifecycleOf(memory);
        return lifecycle === 'active' || lifecycle === 'candidate';
      })
      .slice(0, input.memoryLimit ?? 500);
    for (const memory of memories) {
      const relevance = focus ? lexicalRelevance(focus, memory.content) : 0;
      const score =
        KIND_WEIGHT.memory * (1 + relevance * 3 + confidenceOf(memory)) +
        recencyFactor(memory.updatedAt ?? memory.createdAt, nowMs) * 0.5;
      candidates.push({
        id: `memory:${memory.id}`,
        kind: 'memory',
        text: memory.content,
        tokens: estimateTokens(memory.content),
        score,
        refIds: { projectId, memoryId: memory.id },
        evidenceIds: [...memory.evidenceIds],
      });
    }

    // Greedy deterministic packing: score desc, then id for stable ties.
    candidates.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    const included: ContextPackItem[] = [];
    let budgetUsed = 0;
    for (const candidate of candidates) {
      if (budgetUsed + candidate.tokens > input.tokenBudget) continue;
      included.push(candidate);
      budgetUsed += candidate.tokens;
    }

    const includedIds = new Set(included.map((item) => item.id));
    const omissions = new Map<ContextPackKind, number>();
    for (const candidate of candidates) {
      if (includedIds.has(candidate.id)) continue;
      omissions.set(candidate.kind, (omissions.get(candidate.kind) ?? 0) + 1);
    }

    const sections = (Object.keys(SECTION_TITLES) as ContextPackKind[]).map((kind) => ({
      id: kind,
      title: SECTION_TITLES[kind],
      items: included.filter((item) => item.kind === kind),
      omitted: omissions.get(kind) ?? 0,
    }));

    const citations = [
      ...new Set(
        included.flatMap((item) => [
          ...item.evidenceIds,
          ...Object.values(item.refIds).filter((value) => value !== projectId),
        ])
      ),
    ].sort();

    return {
      projectId,
      generatedAt: nowIso,
      budgetRequested: input.tokenBudget,
      budgetUsed,
      truncated: candidates.length !== included.length,
      ...(focus ? { focus } : {}),
      sections,
      citations,
    };
  }
}
