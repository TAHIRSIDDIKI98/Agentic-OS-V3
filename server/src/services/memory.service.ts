import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { memories } from '../db/client.js';
import { appendAudit, type Tx } from '../lib/audit.js';
import { estimateTokens } from '../lib/tokens.js';
import { randomUUID } from 'node:crypto';
import { ApiError } from '../lib/errors.js';
import { assertOperational } from './safety.service.js';
import { ensureProject } from './project.service.js';
import { statsCache } from '../lib/lru-cache.js';

interface MemoryRow {
  kind: string;
  title: string;
  content: string;
  tags: string[];
  importance: number;
  source: string;
  projectId: string | null;
}

interface CaptureReport {
  distilled: boolean;
  transcriptPreserved: boolean;
  memories: number;
  transcript: string;
  reason?: string;
  /** Memory id of the always-persisted raw transcript row. */
  rawMemoryId?: string;
}

export async function createMemory(input: MemoryRow, actor: string): Promise<unknown> {
  await assertOperational();
  return db.transaction(async (tx: Tx) => {
    await assertOperational(tx);
    let embedding: number[] | undefined;
    try {
      const { embedQuery } = await import('./embeddings.js');
      const emb = await embedQuery(`${input.title} ${input.content}`.slice(0, 8000));
      if (emb) embedding = emb;
    } catch (e) {
      const { log } = await import('../lib/logging.js');
      log.warn('auto_embed_failed_create', {
        title: input.title,
        error: e instanceof Error ? e.message : String(e),
      });
    }

    const [created] = await tx
      .insert(memories)
      .values({
        id: `mem_${randomUUID()}`,
        kind: input.kind,
        title: input.title,
        content: input.content,
        tags: input.tags,
        importance: input.importance,
        source: input.source,
        projectId: input.projectId,
        tokenCost: estimateTokens(input.content),
        recallCount: 0,
        embedding,
      })
      .returning();
    if (!created) throw new Error('Failed to create memory — DB returned no row.');
    // A write invalidates the cached brain snapshot (nexus_stats / dashboard).
    statsCache.delete('stats');
    try {
      const { memoryWritesTotal } = await import('./metrics.js');
      memoryWritesTotal.inc({ kind: created.kind, source: created.source || 'user' });
    } catch {
      // ignore
    }
    await appendAudit(
      'memory.created',
      { id: created.id, kind: created.kind, title: created.title, embedded: Boolean(embedding) },
      actor,
      tx
    );
    return created;
  });
}

export async function updateMemory(
  id: string,
  patch: Partial<MemoryRow>,
  actor: string
): Promise<unknown> {
  await assertOperational();
  return db.transaction(async (tx: Tx) => {
    await assertOperational(tx);
    const existing = await tx.query.memories.findFirst({ where: eq(memories.id, id) });
    if (!existing) throw new ApiError('NOT_FOUND', `Memory ${id} not found.`);
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.title) updates.title = patch.title;
    if (patch.content) {
      updates.content = patch.content;
      updates.tokenCost = estimateTokens(patch.content);
    }
    if (patch.tags) updates.tags = patch.tags;
    if (patch.kind) updates.kind = patch.kind;
    if (patch.importance != null) updates.importance = patch.importance;

    if ((patch.title || patch.content) && !updates.embedding) {
      try {
        const { embedQuery } = await import('./embeddings.js');
        const newText =
          `${patch.title ?? existing.title} ${patch.content ?? existing.content}`.slice(0, 8000);
        const emb = await embedQuery(newText);
        if (emb) updates.embedding = emb;
      } catch (e) {
        const { log } = await import('../lib/logging.js');
        log.warn('auto_embed_failed_update', {
          id,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    const [updated] = await tx.update(memories).set(updates).where(eq(memories.id, id)).returning();
    if (!updated) throw new ApiError('NOT_FOUND', `Memory ${id} not found.`);
    await appendAudit('memory.updated', { id, fields: Object.keys(updates) }, actor, tx);
    return updated;
  });
}

export async function deleteMemory(id: string, actor: string): Promise<void> {
  await assertOperational();
  await db.transaction(async (tx: Tx) => {
    await assertOperational(tx);
    const [deleted] = await tx
      .delete(memories)
      .where(eq(memories.id, id))
      .returning({ id: memories.id });
    if (!deleted) throw new ApiError('NOT_FOUND', `Memory ${id} not found.`);
    await appendAudit('memory.deleted', { id }, actor, tx);
  });
}

export async function checkpoint(
  label: string,
  context: string,
  projectName: string | undefined,
  actor: string
): Promise<unknown> {
  await assertOperational();
  const projectId = projectName ? (await ensureProject(projectName, 'checkpoint')).id : null;
  return db.transaction(async (tx: Tx) => {
    await assertOperational(tx);
    const [row] = await tx
      .insert(memories)
      .values({
        id: `mem_${randomUUID()}`,
        kind: 'episodic',
        title: label.slice(0, 200),
        content: context,
        tags: ['checkpoint'],
        importance: 0.6,
        source: 'checkpoint',
        projectId,
        tokenCost: estimateTokens(context),
        recallCount: 0,
      })
      .returning();
    if (!row) throw new Error('Failed to create checkpoint — DB returned no row.');
    await appendAudit('checkpoint.created', { id: row.id, label, projectId }, actor, tx);
    return row;
  });
}

export async function captureSession(
  transcript: string,
  projectName: string | undefined,
  actor: string,
  forceFail = false,
  /** Agent/client that produced the transcript (attribution). */
  client?: string
): Promise<CaptureReport> {
  await assertOperational();
  let projectId: string | null = null;
  if (projectName) projectId = (await ensureProject(projectName, 'session')).id;

  // Invariant: the raw transcript is ALWAYS committed before distillation.
  // Distillation is lossy and best-effort; losing the source of truth because
  // an extractor failed (or no LLM is configured) is not acceptable.
  const rawMemoryId = `mem_${randomUUID()}`;
  await db.transaction(async (tx: Tx) => {
    await assertOperational(tx);
    await tx.insert(memories).values({
      id: rawMemoryId,
      kind: 'episodic',
      title: 'Session transcript (raw)',
      content: transcript,
      tags: ['session', 'transcript', 'raw', ...(client ? [`client:${client}`] : [])],
      importance: 0.5,
      source: client ? `session-raw:${client}` : 'session-raw',
      projectId,
      tokenCost: estimateTokens(transcript),
      recallCount: 0,
    });
    await appendAudit(
      'session.raw_preserved',
      { rawMemoryId, projectId, characters: transcript.length },
      actor,
      tx
    );
  });

  try {
    if (forceFail) throw new Error('Forced distillation failure.');
    const { distillTranscript } = await import('./llm.js');
    const distilled = await distillTranscript(transcript);
    const created = await db.transaction(async (tx: Tx) => {
      await assertOperational(tx);
      const rows: unknown[] = [];
      for (const d of distilled) {
        const [row] = await tx
          .insert(memories)
          .values({
            id: `mem_${randomUUID()}`,
            kind: d.kind,
            title: d.title.slice(0, 200),
            content: d.content,
            tags: d.tags,
            importance: d.importance,
            source: client ? `session:${client}` : 'session',
            projectId,
            tokenCost: estimateTokens(d.content),
            recallCount: 0,
          })
          .returning();
        rows.push(row);
      }
      await appendAudit(
        'session.captured',
        { distilled: true, memories: rows.length, projectId, rawMemoryId },
        actor,
        tx
      );
      return rows;
    });
    statsCache.delete('stats');
    return {
      distilled: true,
      transcriptPreserved: true,
      memories: created.length,
      transcript,
      rawMemoryId,
    };
  } catch (e) {
    const reason = e instanceof Error ? e.message : 'distillation failed';
    // The raw transcript is already committed; record the failed distillation
    // and never remove or replace the preserved copy.
    await appendAudit(
      'session.captured',
      { distilled: false, transcriptPreserved: true, reason, rawMemoryId },
      actor
    );
    return {
      distilled: false,
      transcriptPreserved: true,
      memories: 0,
      transcript,
      reason,
      rawMemoryId,
    };
  }
}

export type { MemoryRow, CaptureReport };

import { fedRecall } from './federated-recall.js';
import { deduplicateMemories } from './memory-dedup.js';

export interface SemanticRecallOptions {
  projectId?: string;
  limit?: number;
  actor?: string;
  budget?: number;
  includeFederated?: boolean;
}

export interface SemanticRecallHit {
  id: string;
  content: string;
  score: number;
  source?: string;
}

/**
 * Recall-aware read path for the memory core. Routes through the advanced
 * FederatedRecall engine (proof-of-memory, privacy budget, RRF fusion, dedup)
 * so the core memory service is tightly integrated with the retrieval layer.
 */
export async function semanticRecallMemory(
  text: string,
  opts: SemanticRecallOptions = {}
): Promise<SemanticRecallHit[]> {
  const actor = opts.actor ?? 'memory-service';
  const budget = opts.budget ?? 2000;
  const result = await fedRecall.search({
    text,
    budget,
    actor,
    options: {
      limit: opts.limit ?? 10,
      dedupeContent: true,
      includeFederated: opts.includeFederated ?? true,
    },
  });
  return result.returned.map((r) => ({
    id: r.id,
    content: r.content,
    score: r.score,
    source: r.source,
  }));
}

export interface CreateResult {
  id: string;
  mergedInto?: string;
  created: boolean;
}

/**
 * Self-healing memory creation. Writes the memory via the standard capture
 * path (which already embeds + curates + audit-chains), then runs a project
 * scoped dedup pass so a redundant near-duplicate is auto-merged instead of
 * persisting drift. Returns whether a merge occurred. Falls back to a plain
 * create result if the dedup pass fails (never loses the write).
 */
export async function createMemorySelfHealing(
  input: MemoryRow,
  actor: string
): Promise<CreateResult> {
  await assertOperational();
  const created = (await createMemory(input, actor)) as { id: string };
  let mergedInto: string | undefined;
  try {
    if (created.id) {
      const res = await deduplicateMemories({ projectId: input.projectId ?? undefined });
      if (res.merged > 0) mergedInto = created.id;
    }
  } catch (e) {
    const { log } = await import('../lib/logging.js');
    log.warn('selfheal_dedup_pass_failed', {
      id: created.id,
      error: e instanceof Error ? e.message : String(e),
    });
  }
  return { id: created.id, mergedInto, created: true };
}
