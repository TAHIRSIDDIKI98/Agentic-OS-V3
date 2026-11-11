/**
 * schema.ts — normalized PostgreSQL schema (Drizzle ORM).
 * Matches the NEXUS 2.0 spec: NOT NULL columns, unique constraints, and
 * indexes on every hot query path. Audit log is append-only + hash-chained.
 */
import {
  pgTable,
  text,
  timestamp,
  integer,
  real,
  jsonb,
  boolean,
  uniqueIndex,
  index,
  bigint,
  vector,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/** Embedding column — 1536-dimensional vector for PG. */
const embeddingCol = () => vector('embedding', { dimensions: 1536 });

// ─────────────────────────────────────────────────────────────────────────────
// Phase 12 — Advanced Memory Systems support tables
// ─────────────────────────────────────────────────────────────────────────────

/** Topic clusters produced by HDBSCAN + LLM clustering (12.3). */
export const memoryClusters = pgTable(
  'memory_clusters',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull().default('default'),
    label: text('label').notNull(),
    centroidEmbedding: jsonb('centroid_embedding'),
    singletonRatio: real('singleton_ratio').notNull().default(0),
    size: integer('size').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projIdx: index('mem_cluster_proj_idx').on(t.projectId),
    sizeIdx: index('mem_cluster_size_idx').on(t.size),
  })
);

/** Membership of memories within a cluster (12.3, 12.29). */
export const memoryClusterMembers = pgTable(
  'memory_cluster_members',
  {
    clusterId: text('cluster_id')
      .notNull()
      .references(() => memoryClusters.id, { onDelete: 'cascade' }),
    memoryId: text('memory_id').notNull(),
  },
  (t) => ({
    pk: uniqueIndex('mem_cluster_members_pk').on(t.clusterId, t.memoryId),
    memIdx: index('mem_cluster_members_mem_idx').on(t.memoryId),
  })
);

/** Cross-session linkage edges used by the stitcher (12.4). */
export const sessionLinks = pgTable(
  'session_links',
  {
    fromSession: text('from_session').notNull(),
    toSession: text('to_session').notNull(),
    strength: real('strength').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: uniqueIndex('session_links_pk').on(t.fromSession, t.toSession),
  })
);

/** Temporal causal chains between memories (12.13). */
export const memoryCausalEdges = pgTable(
  'memory_causal_edges',
  {
    id: text('id').primaryKey(),
    fromMemoryId: text('from_memory_id').notNull(),
    toMemoryId: text('to_memory_id').notNull(),
    relation: text('relation').notNull(),
    confidence: real('confidence').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    fromIdx: index('mem_causal_from_idx').on(t.fromMemoryId),
    toIdx: index('mem_causal_to_idx').on(t.toMemoryId),
  })
);

/** Detected contradictions between memories (12.6). */
export const memoryContradictions = pgTable(
  'memory_contradictions',
  {
    id: text('id').primaryKey(),
    memoryA: text('memory_a').notNull(),
    memoryB: text('memory_b').notNull(),
    relation: text('relation').notNull(),
    resolutionOf: text('resolution_of'),
    resolved: boolean('resolved').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ resolvedIdx: index('mem_contradiction_resolved_idx').on(t.resolved) })
);

/** Emotional / mood tagging of memories (12.11). */
export const memoryEmotions = pgTable(
  'memory_emotions',
  {
    id: text('id').primaryKey(),
    memoryId: text('memory_id').notNull(),
    mood: text('mood').notNull(),
    valence: real('valence').notNull().default(0),
    arousal: real('arousal').notNull().default(0),
    model: text('model'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ memIdx: index('mem_emotion_mem_idx').on(t.memoryId) })
);

/** Tag taxonomy (12.30). */
export const tagTaxonomy = pgTable(
  'tag_taxonomy',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    parent: text('parent'),
    parentId: text('parent_id'),
    kind: text('kind').notNull().default('user'),
  },
  (t) => ({ nameIdx: index('tag_taxonomy_name_idx').on(t.name) })
);

/** Memory → tag taxonomy associations (12.30). */
export const memoryTags = pgTable(
  'memory_tags',
  {
    memoryId: text('memory_id').notNull(),
    tagId: text('tag_id').notNull(),
  },
  (t) => ({
    pk: uniqueIndex('memory_tags_pk').on(t.memoryId, t.tagId),
    tagIdx: index('memory_tags_tag_idx').on(t.tagId),
  })
);

/** Memory templates (12.33). */
export const memoryTemplates = pgTable('memory_templates', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  spec: jsonb('spec').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Diff-sync markers for multi-brain export (12.22). */
export const memoryDiffMarkers = pgTable(
  'memory_diff_markers',
  {
    id: text('id').primaryKey(),
    memoryId: text('memory_id').notNull(),
    peerId: text('peer_id').notNull(),
    hash: text('hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ peerIdx: index('mem_diff_peer_idx').on(t.peerId) })
);

/** SM-2 rehearsal log for spaced repetition (12.9). */
export const memoryRehearsalLog = pgTable(
  'memory_rehearsal_log',
  {
    id: text('id').primaryKey(),
    memoryId: text('memory_id').notNull(),
    projectId: text('project_id'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }).notNull().defaultNow(),
    grade: real('grade').notNull(),
    intervalDays: real('interval_days').notNull().default(1),
  },
  (t) => ({ memIdx: index('mem_rehearsal_mem_idx').on(t.memoryId) })
);

/** Human feedback used by the ranking trainer (12.10). */
/** Multi-modal attachments store (12.14). */
export const memoryAttachments = pgTable(
  'memory_attachments',
  {
    id: text('id').primaryKey(),
    memoryId: text('memory_id')
      .notNull()
      .references(() => memories.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull().default('file'),
    fileName: text('file_name').notNull().default(''),
    mimeType: text('mime_type').notNull().default('application/octet-stream'),
    sizeBytes: integer('size_bytes').notNull().default(0),
    content: text('content').notNull().default(''),
    thumbnail: text('thumbnail'),
    highlighted: text('highlighted'),
    language: text('language'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ memIdx: index('mem_attach_memory_idx').on(t.memoryId) })
);

/** Human feedback used by the ranking trainer (12.10). */
/** Cold-storage tier archive (12.26). */
export const memoryArchive = pgTable(
  'memory_archive',
  {
    id: text('id').primaryKey(),
    originalId: text('original_id').notNull(),
    kind: text('kind').notNull().default('fact'),
    title: text('title').notNull(),
    content: text('content').notNull(),
    tags: text('tags').array().notNull().default([]),
    importance: real('importance').notNull().default(0.1),
    source: text('source').notNull().default('archived'),
    projectId: text('project_id'),
    tokenCost: integer('token_cost').notNull().default(0),
    archivedAt: timestamp('archived_at', { withTimezone: true }).notNull().defaultNow(),
    reason: text('reason'),
  },
  (t) => ({ originalIdx: index('mem_archive_original_idx').on(t.originalId) })
);

/** Per-agent / per-project memory quotas (12.25). */
export const agentMemoryQuotas = pgTable(
  'agent_memory_quotas',
  {
    agentId: text('agent_id').primaryKey(),
    maxCount: integer('max_count').notNull().default(1000),
    maxTokens: integer('max_tokens').notNull().default(1000000),
    usedCount: integer('used_count').notNull().default(0),
    usedTokens: integer('used_tokens').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ agentIdx: index('agent_mem_quota_agent_idx').on(t.agentId) })
);

export const memories = pgTable(
  'memories',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull(), // episodic | semantic | preference | reflexion | fact
    title: text('title').notNull(),
    content: text('content').notNull(),
    tags: text('tags').array().notNull().default([]),
    importance: real('importance').notNull().default(0.5),
    source: text('source').notNull().default('manual'),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
    tokenCost: integer('token_cost').notNull().default(0),
    recallCount: integer('recall_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    lastRecalledAt: timestamp('last_recalled_at', { withTimezone: true }),
    language: text('language'),
    privacyZone: text('privacy_zone'),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    confidence: real('confidence'),
    version: integer('version'),
    clusterId: text('cluster_id').references(() => memoryClusters.id, { onDelete: 'set null' }),
    supersededBy: text('superseded_by'),
    tier: text('tier').notNull().default('stm'),
    decayHalflifeHours: real('decay_halflife_hours').notNull().default(168),
    rehearsalCount: integer('rehearsal_count').notNull().default(0),
    nextReviewAt: timestamp('next_review_at', { withTimezone: true }),
    embedding: embeddingCol(),
  },
  (t) => ({
    kindIdx: index('mem_kind_idx').on(t.kind),
    importanceIdx: index('mem_importance_idx').on(t.importance),
    createdIdx: index('mem_created_idx').on(t.createdAt),
    projectIdx: index('mem_project_idx').on(t.projectId),
    embeddingIdx: index('mem_embedding_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
    kindImportanceIdx: index('memories_kind_importance_idx').on(t.kind, t.importance),
    tagsGinIdx: index('mem_tags_gin_idx').using('gin', t.tags),
    kindCheck: check(
      'mem_kind_check',
      sql`${t.kind} IN ('episodic', 'semantic', 'preference', 'reflexion', 'fact')`
    ),
  })
);

export const skills = pgTable(
  'skills',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull(),
    content: text('content').notNull(),
    category: text('category').notNull().default('general'),
    tags: text('tags').array().notNull().default([]),
    trigger: text('trigger'),
    rating: real('rating').notNull().default(0),
    useCount: integer('use_count').notNull().default(0),
    successCount: integer('success_count').notNull().default(0),
    failureCount: integer('failure_count').notNull().default(0),
    source: text('source').notNull().default('manual'),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    embedding: embeddingCol(),
  },
  (t) => ({
    // Skill name is unique within a project (or globally when project is null).
    // COALESCE makes NULLs behave as '' so the unique constraint actually holds
    // (otherwise Postgres treats each NULL project_id as distinct).
    nameUnique: uniqueIndex('skill_name_unique').on(t.name, sql`COALESCE(${t.projectId}, '')`),
    categoryIdx: index('skill_category_idx').on(t.category),
    ratingIdx: index('skill_rating_idx').on(t.rating),
    embeddingIdx: index('skill_embedding_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
  })
);

export const projects = pgTable(
  'projects',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    source: text('source').notNull().default('manual'),
    status: text('status').notNull().default('active'),
    memoryCount: integer('memory_count').notNull().default(0),
    skillCount: integer('skill_count').notNull().default(0),
    tokenFootprint: integer('token_footprint').notNull().default(0),
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    nameUnique: uniqueIndex('project_name_unique').on(t.name),
    statusCheck: check(
      'project_status_check',
      sql`${t.status} IN ('active', 'archived', 'paused')`
    ),
  })
);

export const notes = pgTable(
  'notes',
  {
    id: text('id').primaryKey(),
    path: text('path').notNull(),
    title: text('title').notNull().default(''),
    content: text('content').notNull(),
    frontmatter: jsonb('frontmatter').notNull().default({}),
    tags: text('tags').array().notNull().default([]),
    wikilinks: text('wikilinks').array().notNull().default([]),
    charCount: integer('char_count').notNull().default(0),
    mtime: timestamp('mtime', { withTimezone: true }),
    indexedAt: timestamp('indexed_at', { withTimezone: true }).notNull().defaultNow(),
    embedding: embeddingCol(),
  },
  (t) => ({
    pathUnique: uniqueIndex('note_path_unique').on(t.path),
    indexedAtIdx: index('note_indexed_at_idx').on(t.indexedAt),
    embeddingIdx: index('note_embedding_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
  })
);

export const auditLog = pgTable(
  'audit_log',
  {
    // Monotonic sequence is the single primary key (and the chain ordering key).
    // The text `id` is a unique secondary identifier, NOT a second primary key.
    sequence: bigint('sequence', { mode: 'number' }).primaryKey(),
    id: text('id').notNull().unique(),
    actor: text('actor').notNull(),
    action: text('action').notNull(),
    payload: jsonb('payload').notNull().default({}),
    prevHash: text('prev_hash').notNull(),
    entryHash: text('entry_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    seqIdx: index('audit_seq_idx').on(t.sequence),
    createdAtIdx: index('audit_created_idx').on(t.createdAt),
    payloadGinIdx: index('audit_payload_gin_idx').using('gin', t.payload),
  })
);

export const merkleCheckpoints = pgTable('merkle_checkpoints', {
  id: text('id').primaryKey(),
  chunkStartSeq: bigint('chunk_start_seq', { mode: 'number' }).notNull(),
  chunkEndSeq: bigint('chunk_end_seq', { mode: 'number' }).notNull(),
  merkleRoot: text('merkle_root').notNull(),
  prevCheckpointHash: text('prev_checkpoint_hash').notNull(),
  entryCount: integer('entry_count').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const anchoredRoots = pgTable(
  'anchored_roots',
  {
    id: text('id').primaryKey(),
    checkpointId: text('checkpoint_id')
      .notNull()
      .references(() => merkleCheckpoints.id),
    merkleRoot: text('merkle_root').notNull(),
    chainId: integer('chain_id').notNull(),
    txHash: text('tx_hash').notNull(),
    blockNumber: bigint('block_number', { mode: 'number' }),
    status: text('status').notNull().default('pending'), // pending | confirmed | failed
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  },
  (t) => ({
    cpIdx: index('anchor_checkpoint_idx').on(t.checkpointId),
    rootIdx: index('anchor_root_idx').on(t.merkleRoot),
    statusCheck: check(
      'anchor_status_check',
      sql`${t.status} IN ('pending', 'confirmed', 'failed')`
    ),
  })
);

export const tokenLedger = pgTable('token_ledger', {
  id: text('id').primaryKey(),
  eventType: text('event_type').notNull(),
  query: text('query').notNull().default(''),
  tokensInjected: integer('tokens_injected').notNull().default(0),
  tokensReused: integer('tokens_reused').notNull().default(0),
  tokensSaved: integer('tokens_saved').notNull().default(0),
  itemsReturned: integer('items_returned').notNull().default(0),
  real: boolean('real').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const feedback = pgTable(
  'feedback',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull().default('default'),
    query: text('query').notNull(),
    itemId: text('item_id').notNull(),
    itemType: text('item_type').notNull(),
    helpful: boolean('helpful').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projIdx: index('feedback_proj_idx').on(t.projectId),
    itemIdx: index('feedback_item_idx').on(t.itemId),
  })
);

export const systemMeta = pgTable('system_meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const apiKeys = pgTable(
  'api_keys',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    keyHash: text('key_hash').notNull(),
    scopes: text('scopes').array().notNull().default([]),
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  },
  (t) => ({
    // A key hash must be unique — prevents duplicate keys and enables fast lookup.
    hashUnique: uniqueIndex('apikey_hash_unique').on(t.keyHash),
  })
);

/* ════════════════════════════════════════════════════════════════ *
 * PHASE 1.5: Advanced Audit Engine
 *   - trajectory_logs: LLM reasoning traces linked to audit chain
 *   - tool_receipts: cryptographic pre/post-mutation hashes
 * ════════════════════════════════════════════════════════════════ */

export const trajectoryLogs = pgTable(
  'trajectory_logs',
  {
    id: text('id').primaryKey(),
    auditSequence: bigint('audit_sequence', { mode: 'number' }).notNull(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    model: text('model').notNull(),
    promptSent: text('prompt_sent').notNull(),
    responseReceived: text('response_received').notNull().default(''),
    tokenUsage: jsonb('token_usage').notNull().default({}),
    latencyMs: integer('latency_ms').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    auditIdx: index('traj_audit_idx').on(t.auditSequence),
    agentIdx: index('traj_agent_idx').on(t.agentId),
  })
);

export const toolReceipts = pgTable(
  'tool_receipts',
  {
    id: text('id').primaryKey(),
    auditSequence: bigint('audit_sequence', { mode: 'number' }).notNull(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    tool: text('tool').notNull(),
    target: text('target'), // file path, command, URL, etc.
    preHash: text('pre_hash'), // hash of state before mutation
    postHash: text('post_hash'), // hash of state after mutation
    exitCode: integer('exit_code'),
    authorized: boolean('authorized').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    auditIdx: index('receipt_audit_idx').on(t.auditSequence),
    agentIdx: index('receipt_agent_idx').on(t.agentId),
  })
);

/* ════════════════════════════════════════════════════════════════ *
 * PHASE 3: Multi-Agent Microkernel
 *   - agents: registry of all master + sub-agents
 *   - agent_tasks: scheduled/running/completed work items
 *   - cron_jobs: 24/7 autonomous waking daemons
 * ════════════════════════════════════════════════════════════════ */

export const agents = pgTable(
  'agents',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    kind: text('kind').notNull().default('sub-agent'), // master | sub-agent | daemon
    parentId: text('parent_id'), // master agent that spawned this one
    ring: integer('ring').notNull().default(1), // 0-4 execution ring
    scopes: text('scopes').array().notNull().default([]),
    status: text('status').notNull().default('idle'), // idle | thinking | executing_tool | errored | quarantined | completed | paused | terminated
    currentTool: text('current_tool'),
    llmModel: text('llm_model'),
    tokenBudget: integer('token_budget').notNull().default(100000),
    tokensUsed: integer('tokens_used').notNull().default(0),
    timeoutMs: integer('timeout_ms').notNull().default(120000),
    maxRetries: integer('max_retries').notNull().default(3),
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    lastHeartbeatAt: timestamp('last_heartbeat_at', { withTimezone: true }),
    schedulingMode: text('scheduling_mode').notNull().default('preemptive'), // 'cooperative' | 'preemptive'
    cgroup: jsonb('cgroup').notNull().default({}), // { cpuWeight?, memWeight?, tokenShare? }
  },
  (t) => ({
    parentIdx: index('agent_parent_idx').on(t.parentId),
    statusIdx: index('agent_status_idx').on(t.status),
    kindCheck: check('agent_kind_check', sql`${t.kind} IN ('master', 'sub-agent', 'daemon')`),
    statusCheck: check(
      'agent_status_check',
      sql`${t.status} IN ('idle', 'thinking', 'executing_tool', 'errored', 'quarantined', 'completed', 'paused', 'terminated')`
    ),
    schedulingModeCheck: check(
      'agent_scheduling_mode_check',
      sql`${t.schedulingMode} IN ('cooperative', 'preemptive')`
    ),
  })
);

export const agentTasks = pgTable(
  'agent_tasks',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    kind: text('kind').notNull().default('interactive'), // interactive | background | maintenance | safety | self_improvement
    queue: text('queue').notNull().default('Q1'), // Q0-Q4
    priority: integer('priority').notNull().default(80),
    status: text('status').notNull().default('queued'), // queued | running | succeeded | failed | cancelled | dead_letter
    input: jsonb('input').notNull().default({}),
    output: jsonb('output'),
    error: text('error'),
    idempotencyKey: text('idempotency_key'),
    retryCount: integer('retry_count').notNull().default(0),
    maxRetries: integer('max_retries').notNull().default(3),
    traceId: text('trace_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    deadline: timestamp('deadline', { withTimezone: true }), // nullable — EDF hard-real-time
    quantumMs: integer('quantum_ms'), // nullable — preemptive timeslice
    checkpoint: jsonb('checkpoint').notNull().default({}), // context save/restore snapshot
    gangId: text('gang_id'), // nullable — gang scheduling group id
    estimatedDurationMs: integer('estimated_duration_ms'), // nullable — admission control
  },
  (t) => ({
    agentIdx: index('task_agent_idx').on(t.agentId),
    statusIdx: index('task_status_idx').on(t.status),
    queueIdx: index('task_queue_idx').on(t.queue),
    idemUnique: uniqueIndex('task_idem_unique').on(t.idempotencyKey),
    statusPriorityQueueIdx: index('agent_tasks_status_priority_queue_idx').on(
      t.status,
      t.priority,
      t.queue
    ),
    queuedPriorityCreatedIdx: index('agent_tasks_queued_priority_created_idx')
      .on(t.priority, t.createdAt)
      .where(sql`status = 'queued'`),
    agentStatusIdx: index('agent_tasks_agent_status_idx').on(t.agentId, t.status),
    queueDeadlineIdx: index('task_queue_deadline_idx').on(t.queue, t.deadline),
    kindCheck: check(
      'task_kind_check',
      sql`${t.kind} IN ('interactive', 'background', 'maintenance', 'safety', 'self_improvement')`
    ),
    queueCheck: check('task_queue_check', sql`${t.queue} IN ('Q0', 'Q1', 'Q2', 'Q3', 'Q4')`),
    statusCheck: check(
      'task_status_check',
      sql`${t.status} IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'dead_letter')`
    ),
  })
);

export const ringPolicies = pgTable(
  'ring_policies',
  {
    id: text('id').primaryKey(),
    ring: integer('ring').notNull().unique(),
    tools: text('tools').array().notNull().default([]),
    maxConcurrency: integer('max_concurrency').notNull().default(0),
    maxTokensPerMin: integer('max_tokens_per_min').notNull().default(0),
    maxApiCallsPerMin: integer('max_api_calls_per_min').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    ringIdx: index('ring_policy_ring_idx').on(t.ring),
    ringCheck: check('ring_policy_ring_check', sql`${t.ring} BETWEEN 0 AND 4`),
  })
);

export const schedulerMetrics = pgTable(
  'scheduler_metrics',
  {
    id: text('id').primaryKey(),
    queue: text('queue').notNull(),
    p50: real('p50').notNull().default(0),
    p90: real('p90').notNull().default(0),
    p99: real('p99').notNull().default(0),
    p999: real('p999').notNull().default(0),
    sampleCount: integer('sample_count').notNull().default(0),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    windowEnd: timestamp('window_end', { withTimezone: true }).notNull(),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    queueIdx: index('scheduler_metrics_queue_idx').on(t.queue),
  })
);

export const cronJobs = pgTable(
  'cron_jobs',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    cron: text('cron').notNull(), // cron expression, e.g. "0 9 * * *"
    agentKind: text('agent_kind').notNull().default('daemon'),
    taskLabel: text('task_label').notNull(),
    taskInput: jsonb('task_input').notNull().default({}),
    enabled: boolean('enabled').notNull().default(true),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }),
    runCount: integer('run_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    enabledIdx: index('cron_enabled_idx').on(t.enabled),
    nextRunIdx: index('cron_nextrun_idx').on(t.nextRunAt),
    enabledNextRunIdx: index('cron_jobs_enabled_next_run_idx')
      .on(t.nextRunAt)
      .where(sql`enabled = true`),
  })
);

/* ════════════════════════════════════════════════════════════════ *
 * PHASE 5: Execution & Safety — Sandboxing + Snapshots
 * ════════════════════════════════════════════════════════════════ */

/* ─── PHASE 5a: Trace/Telemetry ─────────────────────────────────── */

export const spanLogs = pgTable(
  'span_logs',
  {
    id: text('id').primaryKey(),
    traceId: text('trace_id').notNull(),
    parentId: text('parent_id'),
    name: text('name').notNull(),
    type: text('type').notNull(), // agent_span | tool_span | llm_span | handoff_span
    status: text('status').notNull().default('ok'), // ok | error | cancelled
    startTimeMs: bigint('start_time_ms', { mode: 'number' }).notNull(),
    endTimeMs: bigint('end_time_ms', { mode: 'number' }),
    durationMs: integer('duration_ms').notNull().default(0),
    attributes: jsonb('attributes').notNull().default({}),
    events: jsonb('events').notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    traceIdx: index('span_trace_idx').on(t.traceId),
    typeIdx: index('span_type_idx').on(t.type),
    createdIdx: index('span_created_idx').on(t.createdAt),
    parentIdx: index('span_parent_idx').on(t.parentId),
    traceParentIdx: index('span_logs_trace_parent_idx').on(t.traceId, t.parentId),
    typeCheck: check(
      'span_type_check',
      sql`${t.type} IN ('agent_span', 'tool_span', 'llm_span', 'handoff_span')`
    ),
    statusCheck: check('span_status_check', sql`${t.status} IN ('ok', 'error', 'cancelled')`),
  })
);

export const sandboxExecutions = pgTable(
  'sandbox_executions',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    type: text('type').notNull().default('docker'), // docker | wasm | browser
    code: text('code').notNull(),
    language: text('language').notNull().default('javascript'),
    exitCode: integer('exit_code'),
    stdout: text('stdout').notNull().default(''),
    stderr: text('stderr').notNull().default(''),
    durationMs: integer('duration_ms').notNull().default(0),
    status: text('status').notNull().default('pending'), // pending | running | completed | failed | timeout
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    agentIdx: index('sandbox_agent_idx').on(t.agentId),
    statusIdx: index('sandbox_status_idx').on(t.status),
    typeCheck: check('sandbox_type_check', sql`${t.type} IN ('docker', 'wasm', 'browser')`),
    statusCheck: check(
      'sandbox_status_check',
      sql`${t.status} IN ('pending', 'running', 'completed', 'failed', 'timeout')`
    ),
  })
);

export const stateSnapshots = pgTable(
  'state_snapshots',
  {
    id: text('id').primaryKey(),
    sagaId: text('saga_id').notNull(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    stepIndex: integer('step_index').notNull(),
    stepName: text('step_name').notNull(),
    context: jsonb('context').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    sagaIdx: index('snap_saga_idx').on(t.sagaId),
  })
);

/* ════════════════════════════════════════════════════════════════ *
 * NEURAL SKILL COMPILATION — JIT code generation for repetitive tasks
 * ════════════════════════════════════════════════════════════════ */

export const compiledScripts = pgTable(
  'compiled_scripts',
  {
    id: text('id').primaryKey(),
    patternSignature: text('pattern_signature').notNull(), // hash of the task pattern
    taskLabel: text('task_label').notNull(), // human-readable description
    triggerPattern: jsonb('trigger_pattern').notNull().default({}), // input shape that triggers this script
    script: text('script').notNull(), // the actual JS/Python code
    language: text('language').notNull().default('javascript'),
    status: text('status').notNull().default('draft'), // draft | testing | active | deprecated
    evalResults: jsonb('eval_results').notNull().default({}), // last eval run results
    timesExecuted: integer('times_executed').notNull().default(0),
    tokensSaved: integer('tokens_saved').notNull().default(0),
    detectedCount: integer('detected_count').notNull().default(0), // how many times the pattern was seen before compilation
    avgLatencyMs: integer('avg_latency_ms').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    sigUnique: uniqueIndex('script_sig_unique').on(t.patternSignature),
    statusIdx: index('script_status_idx').on(t.status),
    statusCheck: check(
      'compiled_script_status_check',
      sql`${t.status} IN ('draft', 'testing', 'active', 'deprecated')`
    ),
  })
);

/* ════════════════════════════════════════════════════════════════ *
 * V3 100x UPGRADE — Re-export all V3 tables from schema-v3-100x
 * ════════════════════════════════════════════════════════════════ */

/* ════════════════════════════════════════════════════════════════════════════
 * V3 100x UPGRADE tables — defined inline so drizzle-kit CJS loader resolves
 * them (re-exports from schema-v3-100x.js fail in CJS).
 * ════════════════════════════════════════════════════════════════════════════ */

/* ─── PILLAR I — Self-Improvement Harness ─────────────────────────── */

export const metricSnapshots = pgTable(
  'metric_snapshots',
  {
    id: text('id').primaryKey(),
    metric: text('metric').notNull(),
    value: real('value').notNull(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    windowEnd: timestamp('window_end', { withTimezone: true }).notNull(),
    tags: jsonb('tags').notNull().default({}),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    metricCapturedIdx: index('metric_snap_metric_captured_idx').on(t.metric, t.capturedAt),
    windowIdx: index('metric_snap_window_idx').on(t.windowStart, t.windowEnd),
  })
);

export const improvementProposals = pgTable(
  'improvement_proposals',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    summary: text('summary').notNull(),
    hypothesis: text('hypothesis').notNull(),
    targetMetric: text('target_metric').notNull(),
    baselineValue: real('baseline_value').notNull(),
    expectedDelta: real('expected_delta').notNull(),
    riskClass: text('risk_class').notNull().default('ADVISORY'),
    status: text('status').notNull().default('draft'),
    patch: jsonb('patch').notNull().default({}),
    rationale: text('rationale').notNull().default(''),
    author: text('author').notNull().default('harness'),
    reviewer: text('reviewer'),
    rolloutPct: integer('rollout_pct').notNull().default(0),
    measuredDelta: real('measured_delta'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
  },
  (t) => ({
    statusIdx: index('imp_prop_status_idx').on(t.status),
    metricIdx: index('imp_prop_metric_idx').on(t.targetMetric),
    riskIdx: index('imp_prop_risk_idx').on(t.riskClass),
    createdIdx: index('imp_prop_created_idx').on(t.createdAt),
    riskCheck: check(
      'imp_prop_risk_check',
      sql`${t.riskClass} IN ('ADVISORY', 'BLOCKING', 'SAFETY')`
    ),
    statusCheck: check(
      'imp_prop_status_check',
      sql`${t.status} IN ('draft', 'testing', 'canary', 'rolled_out', 'reverted', 'rejected')`
    ),
  })
);

/* ─── PILLAR II — WASM Plugin Runtime ─────────────────────────────── */

export const plugins = pgTable(
  'plugins',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    version: text('version').notNull(),
    description: text('description').notNull().default(''),
    authorPubkey: text('author_pubkey').notNull(),
    signature: text('signature').notNull(),
    contentSha256: text('content_sha256').notNull(),
    manifest: jsonb('manifest').notNull(),
    wasmBytes: text('wasm_bytes'),
    source: text('source').notNull().default('local'),
    homepage: text('homepage'),
    license: text('license'),
    ratingAvg: real('rating_avg').notNull().default(0),
    ratingCount: integer('rating_count').notNull().default(0),
    installCount: integer('install_count').notNull().default(0),
    trustState: text('trust_state').notNull().default('untrusted'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    nameVersionUnique: uniqueIndex('plugin_name_version_unique').on(t.name, t.version),
    nameIdx: index('plugin_name_idx').on(t.name),
    shaIdx: index('plugin_sha_idx').on(t.contentSha256),
    trustIdx: index('plugin_trust_idx').on(t.trustState),
    manifestGinIdx: index('plugin_manifest_gin_idx').using('gin', t.manifest),
    sourceCheck: check(
      'plugin_source_check',
      sql`${t.source} IN ('local', 'marketplace', 'signed-url')`
    ),
    trustCheck: check(
      'plugin_trust_check',
      sql`${t.trustState} IN ('untrusted', 'trusted', 'revoked')`
    ),
  })
);

export const pluginInstallations = pgTable(
  'plugin_installations',
  {
    id: text('id').primaryKey(),
    pluginId: text('plugin_id').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    ringOverride: integer('ring_override'),
    config: jsonb('config').notNull().default({}),
    installedAt: timestamp('installed_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pluginIdx: index('plugin_install_plugin_idx').on(t.pluginId),
    installUnique: uniqueIndex('plugin_install_unique').on(t.pluginId),
  })
);

export const pluginKv = pgTable(
  'plugin_kv',
  {
    id: text('id').primaryKey(),
    pluginId: text('plugin_id').notNull(),
    key: text('key').notNull(),
    value: text('value').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pluginKeyUnique: uniqueIndex('plugin_kv_plugin_key_unique').on(t.pluginId, t.key),
    pluginIdx: index('plugin_kv_plugin_idx').on(t.pluginId),
  })
);

export const pluginReceipts = pgTable(
  'plugin_receipts',
  {
    id: text('id').primaryKey(),
    pluginId: text('plugin_id').notNull(),
    installId: text('install_id'),
    agentId: text('agent_id').references(() => agents.id, { onDelete: 'set null' }),
    capability: text('capability').notNull(),
    inputSha256: text('input_sha256').notNull(),
    outputSha256: text('output_sha256').notNull(),
    exitCode: integer('exit_code').notNull().default(0),
    fuelUsed: text('fuel_used').notNull().default('0'),
    durationMs: integer('duration_ms').notNull().default(0),
    authorized: boolean('authorized').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pluginIdx: index('plugin_receipt_plugin_idx').on(t.pluginId),
    agentIdx: index('plugin_receipt_agent_idx').on(t.agentId),
    createdIdx: index('plugin_receipt_created_idx').on(t.createdAt),
  })
);

/* ─── PILLAR III — Federated Recall ───────────────────────────────── */

export const federatedMemoryProofs = pgTable(
  'federated_memory_proofs',
  {
    id: text('id').primaryKey(),
    originPeerId: text('origin_peer_id').notNull(),
    originPubkey: text('origin_pubkey').notNull(),
    signature: text('signature').notNull(),
    contentSha256: text('content_sha256').notNull(),
    embedding: real('embedding').array(),
    topicTags: text('topic_tags').array().notNull().default([]),
    importance: real('importance').notNull().default(0.5),
    privacyClass: text('privacy_class').notNull().default('public'),
    materialized: boolean('materialized').notNull().default(false),
    rejectReason: text('reject_reason'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
  },
  (t) => ({
    originIdx: index('fed_proof_origin_idx').on(t.originPeerId),
    materializedIdx: index('fed_proof_materialized_idx').on(t.materialized),
    receivedIdx: index('fed_proof_received_idx').on(t.receivedAt),
    privacyCheck: check(
      'fed_proof_privacy_check',
      sql`${t.privacyClass} IN ('public', 'private', 'protected')`
    ),
  })
);

/* ─── PILLAR IV — LLM Gateway v2 ──────────────────────────────────── */

export const llmProviderHealth = pgTable(
  'llm_provider_health',
  {
    provider: text('provider').primaryKey(),
    state: text('state').notNull().default('closed'),
    failureCount: integer('failure_count').notNull().default(0),
    successCount: integer('success_count').notNull().default(0),
    p95Ms: real('p95_ms').notNull().default(0),
    lastFailureAt: timestamp('last_failure_at', { withTimezone: true }),
    lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
    openedAt: timestamp('opened_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    stateIdx: index('llm_prov_state_idx').on(t.state),
    stateCheck: check('llm_prov_state_check', sql`${t.state} IN ('closed', 'half-open', 'open')`),
  })
);

export const llmTokenBudgets = pgTable(
  'llm_token_budgets',
  {
    sessionId: text('session_id').primaryKey(),
    budget: integer('budget').notNull().default(100000),
    used: integer('used').notNull().default(0),
    hardKill: boolean('hard_kill').notNull().default(false),
    reason: text('reason'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    expiresIdx: index('llm_budget_expires_idx').on(t.expiresAt),
  })
);

/* ─── PILLAR V — Pipeline Builder ─────────────────────────────────── */

export const pipelines = pgTable(
  'pipelines',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    dag: jsonb('dag').notNull(),
    trigger: jsonb('trigger').notNull().default({}),
    enabled: boolean('enabled').notNull().default(true),
    author: text('author').notNull().default('user'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    enabledIdx: index('pipeline_enabled_idx').on(t.enabled),
  })
);

export const pipelineRuns = pgTable(
  'pipeline_runs',
  {
    id: text('id').primaryKey(),
    pipelineId: text('pipeline_id').notNull(),
    status: text('status').notNull().default('pending'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    durationMs: integer('duration_ms').notNull().default(0),
    nodeResults: jsonb('node_results').notNull().default({}),
    error: text('error'),
    triggeredBy: text('triggered_by').notNull().default('manual'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pipelineIdx: index('pipeline_run_pipeline_idx').on(t.pipelineId),
    statusIdx: index('pipeline_run_status_idx').on(t.status),
    createdIdx: index('pipeline_run_created_idx').on(t.createdAt),
    pipelineStatusIdx: index('pipeline_runs_pipeline_status_idx').on(t.pipelineId, t.status),
    statusCheck: check(
      'pipeline_run_status_check',
      sql`${t.status} IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')`
    ),
  })
);

/* ─── PHASE 19 — Ecosystem & Marketplace ──────────────────────────────── */

export const marketplacePlugins = pgTable(
  'marketplace_plugins',
  {
    id: text('id').primaryKey(),
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    authorId: text('author_id').notNull(),
    authorName: text('author_name').notNull().default(''),
    category: text('category').notNull().default('general'),
    kind: text('kind').notNull().default('plugin'), // plugin | agent | memory | widget | tool | integration
    license: text('license').notNull().default('MIT'),
    homepage: text('homepage'),
    repository: text('repository'),
    latestVersion: text('latest_version'),
    latestVersionId: text('latest_version_id'),
    avgRating: real('avg_rating').notNull().default(0),
    ratingCount: integer('rating_count').notNull().default(0),
    installCount: integer('install_count').notNull().default(0),
    status: text('status').notNull().default('draft'), // draft | published | deprecated | quarantined
    verified: boolean('verified').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    slugIdx: uniqueIndex('mp_slug_idx').on(t.slug),
    authorIdx: index('mp_author_idx').on(t.authorId),
    categoryIdx: index('mp_category_idx').on(t.category),
    statusIdx: index('mp_status_idx').on(t.status),
    kindIdx: index('mp_kind_idx').on(t.kind),
    statusCheck: check(
      'mp_status_check',
      sql`${t.status} IN ('draft', 'published', 'deprecated', 'quarantined')`
    ),
    kindCheck: check(
      'mp_kind_check',
      sql`${t.kind} IN ('plugin', 'agent', 'memory', 'widget', 'tool', 'integration')`
    ),
  })
);

export const marketplaceVersions = pgTable(
  'marketplace_versions',
  {
    id: text('id').primaryKey(),
    pluginId: text('plugin_id')
      .notNull()
      .references(() => marketplacePlugins.id, { onDelete: 'cascade' }),
    version: text('version').notNull(), // semver
    manifest: jsonb('manifest').notNull().default({}),
    artifactSha256: text('artifact_sha256').notNull(),
    artifactSize: integer('artifact_size').notNull().default(0),
    artifactStorageKey: text('artifact_storage_key').notNull(),
    wasmEntry: text('wasm_entry'), // path to .wasm entry inside bundle
    minEngineVersion: text('min_engine_version'),
    changelog: text('changelog').notNull().default(''),
    signature: text('signature'), // base64 ed25519 over artifactSha256
    signerPubkey: text('signer_pubkey'),
    fuelLimit: integer('fuel_limit').notNull().default(1_000_000_000),
    sandboxProfile: text('sandbox_profile').notNull().default('default'),
    status: text('status').notNull().default('pending'), // pending | approved | rejected
    securityReviewId: text('security_review_id'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pluginVersionIdx: uniqueIndex('mv_plugin_version_idx').on(t.pluginId, t.version),
    statusIdx: index('mv_status_idx').on(t.status),
    publishedIdx: index('mv_published_idx').on(t.publishedAt),
    statusCheck: check('mv_status_check', sql`${t.status} IN ('pending', 'approved', 'rejected')`),
  })
);

export const pluginReviews = pgTable(
  'plugin_reviews',
  {
    id: text('id').primaryKey(),
    pluginId: text('plugin_id')
      .notNull()
      .references(() => marketplacePlugins.id, { onDelete: 'cascade' }),
    versionId: text('version_id').references(() => marketplaceVersions.id, {
      onDelete: 'set null',
    }),
    authorId: text('author_id').notNull(),
    authorName: text('author_name').notNull().default(''),
    rating: integer('rating').notNull(), // 1..5
    title: text('title').notNull().default(''),
    body: text('body').notNull().default(''),
    helpfulCount: integer('helpful_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pluginIdx: index('pr_plugin_idx').on(t.pluginId),
    ratingIdx: index('pr_rating_idx').on(t.rating),
    ratingCheck: check('pr_rating_check', sql`${t.rating} BETWEEN 1 AND 5`),
  })
);

export const pluginDependencies = pgTable(
  'plugin_dependencies',
  {
    id: text('id').primaryKey(),
    pluginId: text('plugin_id')
      .notNull()
      .references(() => marketplacePlugins.id, { onDelete: 'cascade' }),
    versionId: text('version_id')
      .notNull()
      .references(() => marketplaceVersions.id, { onDelete: 'cascade' }),
    depSlug: text('dep_slug').notNull(),
    depVersionRange: text('dep_version_range').notNull().default('*'),
    kind: text('kind').notNull().default('runtime'), // runtime | peer | dev
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    versionIdx: index('pd_version_idx').on(t.versionId),
    depIdx: index('pd_dep_idx').on(t.depSlug),
    kindCheck: check('pd_kind_check', sql`${t.kind} IN ('runtime', 'peer', 'dev')`),
  })
);

export const pluginInstalls = pgTable(
  'plugin_installs',
  {
    id: text('id').primaryKey(),
    pluginId: text('plugin_id')
      .notNull()
      .references(() => marketplacePlugins.id, { onDelete: 'cascade' }),
    versionId: text('version_id')
      .notNull()
      .references(() => marketplaceVersions.id, { onDelete: 'cascade' }),
    tenantId: text('tenant_id').notNull().default('default'),
    installedBy: text('installed_by').notNull(),
    installPath: text('install_path'),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pluginIdx: index('pin_plugin_idx').on(t.pluginId),
    tenantIdx: index('pin_tenant_idx').on(t.tenantId),
    uniqueIdx: uniqueIndex('pin_plugin_tenant_idx').on(t.pluginId, t.tenantId),
  })
);

export const pluginSecurityReviews = pgTable(
  'plugin_security_reviews',
  {
    id: text('id').primaryKey(),
    versionId: text('version_id')
      .notNull()
      .references(() => marketplaceVersions.id, { onDelete: 'cascade' }),
    reviewerId: text('reviewer_id'),
    state: text('state').notNull().default('queued'), // queued | scanning | approved | rejected
    score: integer('score'), // 0..100
    findings: jsonb('findings').notNull().default([]),
    scannedWith: text('scanned_with').notNull().default('static-sandbox'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    versionIdx: index('psr_version_idx').on(t.versionId),
    stateIdx: index('psr_state_idx').on(t.state),
    stateCheck: check(
      'psr_state_check',
      sql`${t.state} IN ('queued', 'scanning', 'approved', 'rejected')`
    ),
  })
);

export const marketplaceIntegrations = pgTable(
  'marketplace_integrations',
  {
    id: text('id').primaryKey(),
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    providerKind: text('provider_kind').notNull(), // webhook | oauth | api-key | mcp
    configSchema: jsonb('config_schema').notNull().default({}),
    authorId: text('author_id').notNull(),
    verified: boolean('verified').notNull().default(false),
    status: text('status').notNull().default('published'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    slugIdx: uniqueIndex('mi_slug_idx').on(t.slug),
    kindIdx: index('mi_kind_idx').on(t.providerKind),
  })
);

export const pluginSigningKeys = pgTable(
  'plugin_signing_keys',
  {
    id: text('id').primaryKey(),
    authorId: text('author_id').notNull(),
    pubkey: text('pubkey').notNull(), // base64 ed25519 public key
    label: text('label').notNull().default('default'),
    revoked: boolean('revoked').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    authorIdx: index('psk_author_idx').on(t.authorId),
  })
);

/* ─── PHASE 18 — AI-Native Self-Optimization (safe-exploration control surface) ───
 * All tables are append-only/immutable. The self-optimization layer never mutates
 * platform state directly — it proposes deltas through owner-owned adapters and records
 * every propose/commit/rollback here. See docs/self-optimization-control-surface.md.
 */

export const selfOptParamVersions = pgTable(
  'self_opt_param_versions',
  {
    id: text('id').primaryKey(),
    tunerId: text('tuner_id').notNull(), // 18.1 .. 18.20
    ownerAgent: text('owner_agent').notNull(), // forge | mnemosyne | atlas | sentinel | pulse | artisan
    targetInterface: text('target_interface').notNull(), // e.g. scheduler.ts:setPidGain
    experimentId: text('experiment_id'),
    parentId: text('parent_id'), // prior version (for rollback chain)
    beforeJson: jsonb('before_json').notNull().default({}),
    afterJson: jsonb('after_json').notNull().default({}),
    status: text('status').notNull().default('shadow'), // shadow | promoted | rolled_back | rejected
    proposedBy: text('proposed_by').notNull().default('pulse'),
    pValue: real('p_value'),
    metricDelta: real('metric_delta'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    promotedAt: timestamp('promoted_at', { withTimezone: true }),
  },
  (t) => ({
    tunerIdx: index('sopv_tuner_idx').on(t.tunerId),
    statusIdx: index('sopv_status_idx').on(t.status),
    ownerIdx: index('sopv_owner_idx').on(t.ownerAgent),
    parentIdx: index('sopv_parent_idx').on(t.parentId),
    expIdx: index('sopv_exp_idx').on(t.experimentId),
    statusCheck: check(
      'sopv_status_check',
      sql`${t.status} IN ('shadow', 'promoted', 'rolled_back', 'rejected')`
    ),
  })
);

export const selfOptExperiments = pgTable(
  'self_opt_experiments',
  {
    id: text('id').primaryKey(),
    tunerId: text('tuner_id').notNull(),
    hypothesis: text('hypothesis').notNull(),
    metric: text('metric').notNull(), // primary metric, e.g. recall.ndcg10
    variantA: jsonb('variant_a').notNull().default({}),
    variantB: jsonb('variant_b').notNull().default({}),
    minSampleSize: integer('min_sample_size').notNull().default(2000),
    alpha: real('alpha').notNull().default(0.05),
    status: text('status').notNull().default('running'), // running | completed | stopped
    winner: text('winner'), // A | B | null
    pValue: real('p_value'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => ({
    tunerIdx: index('soe_tuner_idx').on(t.tunerId),
    statusIdx: index('soe_status_idx').on(t.status),
    statusCheck: check('soe_status_check', sql`${t.status} IN ('running', 'completed', 'stopped')`),
  })
);

export const selfOptKnowledgeBus = pgTable(
  'self_opt_knowledge_bus',
  {
    id: text('id').primaryKey(),
    tunerId: text('tuner_id').notNull(),
    ownerAgent: text('owner_agent').notNull(),
    targetInterface: text('target_interface').notNull(),
    configJson: jsonb('config_json').notNull().default({}),
    score: real('score').notNull().default(0),
    scope: text('scope').notNull().default('local'), // local | global
    publishedBy: text('published_by').notNull().default('pulse'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tunerIdx: index('sokb_tuner_idx').on(t.tunerId),
    ownerIdx: index('sokb_owner_idx').on(t.ownerAgent),
    scopeIdx: index('sokb_scope_idx').on(t.scope),
    scoreIdx: index('sokb_score_idx').on(t.score),
  })
);

export const selfOptEvents = pgTable(
  'self_opt_events',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull(), // propose | commit | rollback | trip | reject | pause | sim
    tunerId: text('tuner_id'),
    ownerAgent: text('owner_agent'),
    actor: text('actor').notNull().default('pulse'),
    detailJson: jsonb('detail_json').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    kindIdx: index('soe_event_kind_idx').on(t.kind),
    tunerIdx: index('soe_event_tuner_idx').on(t.tunerId),
    createdIdx: index('soe_event_created_idx').on(t.createdAt),
    kindCheck: check(
      'soe_event_kind_check',
      sql`${t.kind} IN ('propose', 'commit', 'rollback', 'trip', 'reject', 'pause', 'sim')`
    ),
  })
);

/* ══════════════════════════════════════════════════════════════════╗
 * PHASE 17 — Enterprise Features (OIDC/SAML, RBAC, multi-tenant, billing)
 *   orgs / workspaces: org hierarchy + tenant isolation
 *   enterpriseUsers: users scoped to an org
 *   enterpriseApiKeys: org-scoped keys with rate-limit tiers
 *   rbacRoles: custom roles + permissions
 *   siemSinks: SIEM streaming destinations
 *   tenantConfig: SSO/retention/PITR/CMK/white-label
 *   invoices / paymentMethods / crossOrgShares / onboardingState
 * ══════════════════════════════════════════════════════════════════╝ */

export const orgs = pgTable(
  'orgs',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    slug: text('slug').notNull().unique(),
    parentId: text('parent_id'), // nullable for root org (org tree)
    plan: text('plan').notNull().default('free'), // free | team | business | enterprise
    seats: integer('seats').notNull().default(5),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    parentIdx: index('org_parent_idx').on(t.parentId),
    planCheck: check(
      'org_plan_check',
      sql`${t.plan} IN ('free', 'team', 'business', 'enterprise')`
    ),
  })
);

export const workspaces = pgTable(
  'workspaces',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    region: text('region').notNull().default('us-east-1'),
    dataResidency: text('data_residency').notNull().default('us'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ orgIdx: index('ws_org_idx').on(t.orgId) })
);

export const enterpriseUsers = pgTable(
  'enterprise_users',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    name: text('name').notNull(),
    roles: text('roles').array().notNull().default(['member']),
    status: text('status').notNull().default('active'), // active | invited | suspended | deactivated
    mfaEnabled: boolean('mfa_enabled').notNull().default(false),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index('entu_org_idx').on(t.orgId),
    emailIdx: uniqueIndex('entu_org_email_unique').on(t.orgId, t.email),
    statusCheck: check(
      'entu_status_check',
      sql`${t.status} IN ('active', 'invited', 'suspended', 'deactivated')`
    ),
  })
);

export const enterpriseApiKeys = pgTable(
  'enterprise_api_keys',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    prefix: text('prefix').notNull(),
    keyHash: text('key_hash').notNull().unique(),
    tier: text('tier').notNull().default('free'), // free | tier1 | tier2 | tier3
    scopes: text('scopes').array().notNull().default([]),
    rateLimitRpm: integer('rate_limit_rpm').notNull().default(60),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    status: text('status').notNull().default('active'), // active | revoked
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index('ekey_org_idx').on(t.orgId),
    tierCheck: check('ekey_tier_check', sql`${t.tier} IN ('free', 'tier1', 'tier2', 'tier3')`),
    statusCheck: check('ekey_status_check', sql`${t.status} IN ('active', 'revoked')`),
  })
);

export const rbacRoles = pgTable(
  'rbac_roles',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    isCustom: boolean('is_custom').notNull().default(true),
    permissions: text('permissions').array().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ orgIdx: uniqueIndex('rbac_org_name_unique').on(t.orgId, t.name) })
);

export const siemSinks = pgTable(
  'siem_sinks',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull().default('webhook'), // webhook | splunk | datadog | elastic
    endpoint: text('endpoint').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index('siem_org_idx').on(t.orgId),
    kindCheck: check(
      'siem_kind_check',
      sql`${t.kind} IN ('webhook', 'splunk', 'datadog', 'elastic')`
    ),
  })
);

export const tenantConfig = pgTable(
  'tenant_config',
  {
    orgId: text('org_id')
      .primaryKey()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    ssoProvider: text('sso_provider').notNull().default('none'), // none | oidc | saml
    ssoEnabled: boolean('sso_enabled').notNull().default(false),
    ssoIdpInitiated: boolean('sso_idp_initiated').notNull().default(false),
    ssoEntityId: text('sso_entity_id').notNull().default(''),
    ssoAcsUrl: text('sso_acs_url').notNull().default(''),
    ssoSsoUrl: text('sso_sso_url').notNull().default(''),
    ssoCert: text('sso_cert').notNull().default(''),
    ssoJitProvisioning: boolean('sso_jit_provisioning').notNull().default(false),
    ssoDomainRestriction: text('sso_domain_restriction').array().notNull().default([]),
    auditRetentionDays: integer('audit_retention_days').notNull().default(365),
    memoryRetentionDays: integer('memory_retention_days').notNull().default(365),
    backupPitr: boolean('backup_pitr').notNull().default(false),
    cmkEnabled: boolean('cmk_enabled').notNull().default(false),
    cmkKeyId: text('cmk_key_id'),
    themePrimary: text('theme_primary').notNull().default('#06b6d4'),
    themeLogoUrl: text('theme_logo_url').notNull().default(''),
    themeBrandName: text('theme_brand_name').notNull().default('NEXUS'),
    budgetAlertPct: integer('budget_alert_pct').notNull().default(80),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    ssoProviderCheck: check(
      'tc_sso_provider_check',
      sql`${t.ssoProvider} IN ('none', 'oidc', 'saml')`
    ),
  })
);

export const invoices = pgTable(
  'invoices',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    period: text('period').notNull(),
    amountUsd: integer('amount_usd').notNull().default(0),
    status: text('status').notNull().default('open'), // open | paid | void
    pdfUrl: text('pdf_url').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index('inv_org_idx').on(t.orgId),
    statusCheck: check('inv_status_check', sql`${t.status} IN ('open', 'paid', 'void')`),
  })
);

export const paymentMethods = pgTable(
  'payment_methods',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    brand: text('brand').notNull().default(''),
    last4: text('last4').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ orgIdx: index('pm_org_idx').on(t.orgId) })
);

export const crossOrgShares = pgTable(
  'cross_org_shares',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull(),
    targetOrgId: text('target_org_id').notNull(),
    resource: text('resource').notNull(), // memory | skill | project
    resourceId: text('resource_id').notNull(),
    role: text('role').notNull().default('viewer'), // viewer | editor
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ orgIdx: index('cos_org_idx').on(t.orgId) })
);

export const onboardingState = pgTable('onboarding_state', {
  orgId: text('org_id').primaryKey(),
  completedSteps: text('completed_steps').array().notNull().default([]),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
