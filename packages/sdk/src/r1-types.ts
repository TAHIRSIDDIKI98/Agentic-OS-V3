/**
 * R1 Shared Domain Types & State Enums (BMAD Story E0-S2)
 * ------------------------------------------------------------------
 * Canonical, versioned vocabulary for projects, tasks, approvals,
 * capabilities, receipts, and evidence. Shared by the server, the
 * frontend, and the SDK so local, server, and UI code cannot drift.
 *
 * Design rules (from the story acceptance criteria):
 *  - Every external JSON payload is parsed at a boundary via the exported
 *    zod schemas. No domain function accepts unvalidated `unknown` data.
 *  - Valid transitions and invalid-transition errors are explicit and
 *    exhaustively covered by the contract tests in `r1-types.test.ts`.
 *  - No provider/driver-specific fields leak into these types.
 *
 * @packageDocumentation
 */
import { z } from 'zod';

/** R1 domain contract version. Bump on any breaking change to these types. */
export const R1_DOMAIN_VERSION = '1.0.0' as const;

/* ------------------------------------------------------------------ *
 * Project
 * ------------------------------------------------------------------ */

export const ProjectModeSchema = z.enum(['local', 'shared']);
export type ProjectMode = z.infer<typeof ProjectModeSchema>;

export const ProjectSyncStateSchema = z.enum(['idle', 'syncing', 'error', 'disabled']);
export type ProjectSyncState = z.infer<typeof ProjectSyncStateSchema>;

/** Health/operational status reported for a project scope (E1-S1 AC3). */
export const ProjectStatusSchema = z.object({
  mode: ProjectModeSchema,
  storageHealthy: z.boolean(),
  providerHealthy: z.boolean(),
  embeddingHealthy: z.boolean(),
  syncState: ProjectSyncStateSchema,
});
export type ProjectStatus = z.infer<typeof ProjectStatusSchema>;

export const ProjectSchema = z.object({
  /** Stable opaque UUID. Never reuse or expose internal row ids. */
  id: z.string().uuid(),
  name: z.string().min(1).max(200),
  mode: ProjectModeSchema,
  /** Root/scope metadata (e.g. local root path, tenant id). */
  scope: z.record(z.string(), z.string()),
  /** Idempotency key used to make initialization repeatable (E1-S1 AC2). */
  idempotencyKey: z.string().min(1).max(255).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Project = z.infer<typeof ProjectSchema>;

/* ------------------------------------------------------------------ *
 * Task state machine
 * ------------------------------------------------------------------ */

export const TaskStateSchema = z.enum([
  'queued',
  'waiting_approval',
  'running',
  'completed',
  'failed',
  'cancelled',
]);
export type TaskState = z.infer<typeof TaskStateSchema>;

export type TaskEvent =
  | 'admit'
  | 'require_approval'
  | 'approve'
  | 'deny'
  | 'complete'
  | 'fail'
  | 'cancel';

export const TaskEventSchema = z.enum([
  'admit',
  'require_approval',
  'approve',
  'deny',
  'complete',
  'fail',
  'cancel',
]);

/**
 * Exhaustive transition table for the governed task lifecycle.
 * Terminal states (`completed` / `failed` / `cancelled`) have no outgoing
 * edges. Any (state, event) pair absent here is an invalid transition.
 */
export const TASK_TRANSITIONS: Readonly<
  Record<TaskState, Readonly<Partial<Record<TaskEvent, TaskState>>>>
> = {
  queued: { admit: 'running', require_approval: 'waiting_approval', cancel: 'cancelled' },
  waiting_approval: { approve: 'running', deny: 'cancelled', cancel: 'cancelled' },
  running: { complete: 'completed', fail: 'failed', cancel: 'cancelled' },
  completed: {},
  failed: {},
  cancelled: {},
};

export class InvalidTaskTransitionError extends Error {
  constructor(
    public readonly from: TaskState,
    public readonly event: TaskEvent,
  ) {
    super(`Invalid task transition: ${from} --${event}--> (no such transition)`);
    this.name = 'InvalidTaskTransitionError';
    Object.setPrototypeOf(this, InvalidTaskTransitionError.prototype);
  }
}

/** Pure predicate: is `event` legal from `from`? */
export function canTransitionTask(from: TaskState, event: TaskEvent): boolean {
  return (TASK_TRANSITIONS[from]?.[event] ?? undefined) !== undefined;
}

/**
 * Apply `event` to a task in state `from`.
 * @throws InvalidTaskTransitionError when the transition is not defined.
 */
export function transitionTask(from: TaskState, event: TaskEvent): TaskState {
  const next = TASK_TRANSITIONS[from]?.[event];
  if (next === undefined) throw new InvalidTaskTransitionError(from, event);
  return next;
}

/* ------------------------------------------------------------------ *
 * Step state (sub-units of a task)
 * ------------------------------------------------------------------ */

export const StepStateSchema = z.enum(['pending', 'running', 'completed', 'failed', 'skipped']);
export type StepState = z.infer<typeof StepStateSchema>;

/* ------------------------------------------------------------------ *
 * Risk, decisions, and policy
 * ------------------------------------------------------------------ */

export const RiskLevelSchema = z.enum(['low', 'medium', 'high']);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const ApprovalDecisionSchema = z.enum(['approved', 'denied']);
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

/**
 * Outcome of evaluating a capability/policy against a proposed action.
 * `require_approval` means the action is permitted only after a human
 * approval decision (see the approval state machine below).
 */
export const PolicyDecisionSchema = z.enum(['allow', 'deny', 'require_approval']);
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;

/* ------------------------------------------------------------------ *
 * Approval request state machine
 * ------------------------------------------------------------------ */

export const ApprovalStateSchema = z.enum(['pending', 'approved', 'denied']);
export type ApprovalState = z.infer<typeof ApprovalStateSchema>;

export type ApprovalEvent = 'approve' | 'deny';

export const ApprovalEventSchema = z.enum(['approve', 'deny']);

export const APPROVAL_TRANSITIONS: Readonly<
  Record<ApprovalState, Readonly<Partial<Record<ApprovalEvent, ApprovalState>>>>
> = {
  pending: { approve: 'approved', deny: 'denied' },
  approved: {},
  denied: {},
};

export class InvalidApprovalTransitionError extends Error {
  constructor(
    public readonly from: ApprovalState,
    public readonly event: ApprovalEvent,
  ) {
    super(`Invalid approval transition: ${from} --${event}--> (no such transition)`);
    this.name = 'InvalidApprovalTransitionError';
    Object.setPrototypeOf(this, InvalidApprovalTransitionError.prototype);
  }
}

export function canTransitionApproval(from: ApprovalState, event: ApprovalEvent): boolean {
  return (APPROVAL_TRANSITIONS[from]?.[event] ?? undefined) !== undefined;
}

export function transitionApproval(from: ApprovalState, event: ApprovalEvent): ApprovalState {
  const next = APPROVAL_TRANSITIONS[from]?.[event];
  if (next === undefined) throw new InvalidApprovalTransitionError(from, event);
  return next;
}

/* ------------------------------------------------------------------ *
 * Capabilities and task payloads
 * ------------------------------------------------------------------ */

/** Explicit inventory entry used by policy evaluation (FR-CAP-001). */
export const CapabilitySchema = z.object({
  id: z.string().min(1).max(255),
  name: z.string().min(1).max(255),
  source: z.enum(['native', 'mcp', 'a2a', 'provider', 'skill']),
  version: z.string().min(1).max(100),
  owner: z.string().min(1).max(255),
  scope: z.record(z.string(), z.string()),
  risk: RiskLevelSchema,
  enabled: z.boolean(),
});
export type Capability = z.infer<typeof CapabilitySchema>;

export const TaskStepSchema = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid(),
  name: z.string().min(1).max(255),
  state: StepStateSchema,
  sequence: z.number().int().nonnegative(),
  capabilityId: z.string().min(1).max(255).optional(),
});
export type TaskStep = z.infer<typeof TaskStepSchema>;

export const TaskSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  /** Authenticated principal that submitted the durable work request. */
  principalId: z.string().min(1).max(255),
  /** Explicit agent identity; task execution must not infer this from input. */
  agentId: z.string().min(1).max(255),
  state: TaskStateSchema,
  title: z.string().min(1).max(500),
  goal: z.string().min(1).max(20_000),
  capabilityIds: z.array(z.string().min(1).max(255)).max(100),
  policyVersion: z.string().min(1).max(100),
  /** Opaque reference to validated input; raw secret-bearing input is not stored here. */
  inputReference: z.string().min(1).max(1_000),
  currentStepId: z.string().uuid().optional(),
  correlationId: z.string().uuid(),
  idempotencyKey: z.string().min(1).max(255),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Task = z.infer<typeof TaskSchema>;

/** Immutable event emitted by the database when a task is created or changes state. */
export const TaskRecordEventSchema = z.object({
  id: z.string().min(1).max(300),
  projectId: z.string().uuid(),
  taskId: z.string().uuid(),
  event: z.enum(['created', 'admit', 'require_approval', 'approve', 'deny', 'complete', 'fail', 'cancel']),
  state: TaskStateSchema,
  sequence: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
});
export type TaskRecordEvent = z.infer<typeof TaskRecordEventSchema>;

/* ------------------------------------------------------------------ *
 * Action receipts and evidence
 * ------------------------------------------------------------------ */

export const ReceiptKindSchema = z.enum([
  'tool_call',
  'file_write',
  'db_write',
  'approval',
  'external_request',
]);
export type ReceiptKind = z.infer<typeof ReceiptKindSchema>;

/** Append-only, content-addressed record of a side effect (E5-S1). */
export const ActionReceiptSchema = z.object({
  id: z.string().uuid(),
  kind: ReceiptKindSchema,
  correlationId: z.string().uuid(),
  projectId: z.string().uuid(),
  actor: z.string().min(1),
  decision: PolicyDecisionSchema,
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.string().datetime(),
});
export type ActionReceipt = z.infer<typeof ActionReceiptSchema>;

/** Append-only provenance record linked from task timelines and exports. */
export const EvidenceSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  taskId: z.string().uuid().optional(),
  kind: z.enum(['provenance', 'trace', 'receipt', 'approval', 'source']),
  source: z.string().min(1).max(255),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/i),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.string().datetime(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

/* ------------------------------------------------------------------ *
 * Provenance-backed memory metadata (E2-S1)
 * ------------------------------------------------------------------ */

export const MemoryLifecycleSchema = z.enum(['candidate', 'active', 'archived', 'forgotten']);
export type MemoryLifecycle = z.infer<typeof MemoryLifecycleSchema>;

/** Metadata that turns retained text into an attributable, policy-reviewable memory. */
export const MemoryProvenanceSchema = z.object({
  type: z.enum(['fact', 'preference', 'decision', 'summary', 'instruction']),
  source: z.string().min(1).max(255),
  confidence: z.number().min(0).max(1),
  lifecycle: MemoryLifecycleSchema,
  agentId: z.string().min(1).max(255).optional(),
  evidenceIds: z.array(z.string().uuid()).min(1).max(100),
});
export type MemoryProvenance = z.infer<typeof MemoryProvenanceSchema>;

export const ProvenanceMemorySchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  content: z.string().min(1).max(100_000),
  metadata: z.object({ provenance: MemoryProvenanceSchema }).catchall(z.unknown()),
  evidenceIds: z.array(z.string().uuid()).min(1).max(100),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ProvenanceMemory = z.infer<typeof ProvenanceMemorySchema>;

/* ------------------------------------------------------------------ *
 * Boundary parsers — the only sanctioned way to ingest untrusted JSON.
 * Each throws a zod ZodError on malformed input rather than silently
 * coercing. Pair these with the `Schema` validators above.
 * ------------------------------------------------------------------ */

export const parseProject = (input: unknown): Project => ProjectSchema.parse(input);
export const parseCapability = (input: unknown): Capability => CapabilitySchema.parse(input);
export const parseTask = (input: unknown): Task => TaskSchema.parse(input);
export const parseTaskStep = (input: unknown): TaskStep => TaskStepSchema.parse(input);
export const parseEvidence = (input: unknown): Evidence => EvidenceSchema.parse(input);
export const parseMemoryProvenance = (input: unknown): MemoryProvenance => MemoryProvenanceSchema.parse(input);
export const parseProvenanceMemory = (input: unknown): ProvenanceMemory => ProvenanceMemorySchema.parse(input);
export const parseTaskState = (input: unknown): TaskState => TaskStateSchema.parse(input);
export const parseApprovalState = (input: unknown): ApprovalState =>
  ApprovalStateSchema.parse(input);
export const parsePolicyDecision = (input: unknown): PolicyDecision =>
  PolicyDecisionSchema.parse(input);
export const parseActionReceipt = (input: unknown): ActionReceipt =>
  ActionReceiptSchema.parse(input);

