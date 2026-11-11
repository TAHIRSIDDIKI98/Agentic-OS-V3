/**
 * SQL-backed R1 repository adapter.
 *
 * The executor is injected so the same adapter can be used with postgres-js,
 * a test transaction, or a local SQL driver without exposing a database client
 * to domain services. Queries use PostgreSQL positional parameters.
 */
import type {
  ActionReceipt,
  ApprovalState,
  Capability,
  Evidence,
  Project,
  Task,
  TaskRecordEvent,
  TaskStep,
} from './r1-types.js';
import type {
  ApprovalRepository,
  ApprovalRequest,
  CapabilityRepository,
  EvidenceRepository,
  MemoryRecord,
  MemoryRepository,
  ProjectRepository,
  ReceiptRepository,
  R1Repositories,
  TaskRepository,
} from './repositories.js';

export interface SqlExecutor {
  query<T extends object>(statement: string, parameters?: readonly unknown[]): Promise<readonly T[]>;
}

export class SqlRepositoryError extends Error {
  constructor(public readonly code: 'NOT_FOUND' | 'ALREADY_EXISTS' | 'PROJECT_SCOPE_VIOLATION', message: string) {
    super(message);
    this.name = 'SqlRepositoryError';
    Object.setPrototypeOf(this, SqlRepositoryError.prototype);
  }
}

const one = <T>(rows: readonly T[]): T | null => rows[0] ?? null;
const projectColumns = 'id, name, mode, scope, idempotency_key AS "idempotencyKey", created_at AS "createdAt", updated_at AS "updatedAt"';

/** PostgreSQL returns JSON/boolean values natively; SQLite returns their TEXT/INTEGER representation. */
function jsonValue(value: unknown, fallback: Record<string, unknown> | readonly string[] = {}): Record<string, unknown> | readonly string[] {
  if (typeof value !== 'string') return (value ?? fallback) as Record<string, unknown> | readonly string[];
  try {
    return JSON.parse(value) as Record<string, unknown> | readonly string[];
  } catch {
    throw new SqlRepositoryError('NOT_FOUND', 'Stored R1 JSON is malformed.');
  }
}

/**
 * PostgreSQL drivers return TIMESTAMPTZ values as Date instances while the
 * SQLite adapter returns the stored ISO text. The R1 domain contract always
 * uses ISO-8601 strings, so normalization happens exactly once — here, at the
 * persistence boundary — keeping both adapters substitutable.
 */
function isoTimestamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  throw new SqlRepositoryError('NOT_FOUND', 'Stored R1 timestamp is malformed.');
}

function stringRecord(value: unknown): Record<string, string> {
  const decoded = jsonValue(value, {});
  if (Array.isArray(decoded) || Object.values(decoded).some((entry) => typeof entry !== 'string')) {
    throw new SqlRepositoryError('NOT_FOUND', 'Stored R1 scope is malformed.');
  }
  return decoded as Record<string, string>;
}

function projectFromRow(row: Project): Project {
  // An absent idempotency key is stored as NULL; the domain contract
  // represents absence as an omitted property.
  const { idempotencyKey, ...project } = row;
  const normalized = {
    ...project,
    scope: stringRecord(row.scope),
    createdAt: isoTimestamp(row.createdAt),
    updatedAt: isoTimestamp(row.updatedAt),
  };
  return idempotencyKey == null ? normalized : { ...normalized, idempotencyKey };
}

function evidenceFromRow(row: Evidence): Evidence {
  // Absent task linkage is stored as NULL; the domain contract omits it.
  const { taskId, ...evidence } = row;
  const normalized = {
    ...evidence,
    metadata: jsonValue(row.metadata, {}) as Record<string, unknown>,
    createdAt: isoTimestamp(row.createdAt),
  };
  return taskId == null ? normalized : { ...normalized, taskId };
}

function memoryFromRow(row: MemoryRecord): MemoryRecord {
  return {
    ...row,
    metadata: jsonValue(row.metadata, {}) as Record<string, unknown>,
    evidenceIds: jsonValue(row.evidenceIds, []) as readonly string[],
    createdAt: isoTimestamp(row.createdAt),
    updatedAt: isoTimestamp(row.updatedAt),
  };
}

function capabilityFromRow(row: Capability): Capability {
  return {
    ...row,
    scope: stringRecord(row.scope),
    enabled: row.enabled === true || (row.enabled as unknown) === 1,
  };
}

function receiptFromRow(row: ActionReceipt): ActionReceipt {
  return { ...row, payload: jsonValue(row.payload, {}) as Record<string, unknown>, createdAt: isoTimestamp(row.createdAt) };
}

function approvalFromRow(row: ApprovalRequest): ApprovalRequest {
  return { ...row, createdAt: isoTimestamp(row.createdAt), updatedAt: isoTimestamp(row.updatedAt) };
}

function taskEventFromRow(row: TaskRecordEvent): TaskRecordEvent {
  return { ...row, createdAt: isoTimestamp(row.createdAt) };
}

class SqlProjects implements ProjectRepository {
  constructor(private readonly sql: SqlExecutor) {}
  async get(id: string): Promise<Project | null> {
    const project = one(await this.sql.query<Project>(`SELECT ${projectColumns} FROM projects WHERE id = $1`, [id]));
    return project ? projectFromRow(project) : null;
  }
  async list(): Promise<readonly Project[]> {
    return (await this.sql.query<Project>(`SELECT ${projectColumns} FROM projects ORDER BY created_at`)).map(projectFromRow);
  }
  async create(project: Project): Promise<Project> {
    const result = await this.sql.query<Project>(
      `INSERT INTO projects (id, name, mode, scope, idempotency_key, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${projectColumns}`,
      [project.id, project.name, project.mode, JSON.stringify(project.scope), project.idempotencyKey ?? null, project.createdAt, project.updatedAt],
    );
    const created = one(result);
    if (!created) throw new SqlRepositoryError('ALREADY_EXISTS', 'Project could not be created.');
    return projectFromRow(created);
  }
  async update(project: Project): Promise<Project> {
    const result = await this.sql.query<Project>(
      `UPDATE projects SET name = $2, mode = $3, scope = $4, updated_at = $5 WHERE id = $1 RETURNING ${projectColumns}`,
      [project.id, project.name, project.mode, JSON.stringify(project.scope), project.updatedAt],
    );
    const updated = one(result);
    if (!updated) throw new SqlRepositoryError('NOT_FOUND', 'Project not found.');
    return projectFromRow(updated);
  }
}

const taskColumns = `id, project_id AS "projectId", principal_id AS "principalId", agent_id AS "agentId",
  state, title, goal, capability_ids AS "capabilityIds", policy_version AS "policyVersion",
  input_reference AS "inputReference", current_step_id AS "currentStepId",
  correlation_id AS "correlationId", idempotency_key AS "idempotencyKey",
  created_at AS "createdAt", updated_at AS "updatedAt"`;

function taskFromRow(row: Task): Task {
  // SQLite returns NULL for an absent optional step while the domain contract
  // represents absence as an omitted property.
  const { currentStepId, ...task } = row;
  const normalized = {
    ...task,
    capabilityIds: jsonValue(row.capabilityIds, []) as string[],
    createdAt: isoTimestamp(row.createdAt),
    updatedAt: isoTimestamp(row.updatedAt),
  };
  return currentStepId == null ? normalized : { ...normalized, currentStepId };
}

class SqlTasks implements TaskRepository {
  constructor(private readonly sql: SqlExecutor) {}
  async get(projectId: string, taskId: string): Promise<Task | null> {
    const task = one(await this.sql.query<Task>(`SELECT ${taskColumns} FROM r1_tasks WHERE id = $1`, [taskId]));
    if (task && task.projectId !== projectId) throw new SqlRepositoryError('PROJECT_SCOPE_VIOLATION', 'Resource is outside the project scope.');
    return task ? taskFromRow(task) : null;
  }
  async list(projectId: string): Promise<readonly Task[]> {
    return (await this.sql.query<Task>(`SELECT ${taskColumns} FROM r1_tasks WHERE project_id = $1 ORDER BY created_at`, [projectId])).map(taskFromRow);
  }
  async create(task: Task): Promise<Task> {
    // The unique project/idempotency constraint and this upsert form one
    // atomic operation. A read-then-insert sequence is racy when two workers
    // submit the same key concurrently and can incorrectly reject one caller.
    const result = await this.sql.query<Task>(`INSERT INTO r1_tasks (
       id, project_id, principal_id, agent_id, state, title, goal, capability_ids,
       policy_version, input_reference, current_step_id, correlation_id,
       idempotency_key, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (project_id, idempotency_key) DO UPDATE
       SET idempotency_key = r1_tasks.idempotency_key
     RETURNING ${taskColumns}`,
      [task.id, task.projectId, task.principalId, task.agentId, task.state, task.title,
        task.goal, JSON.stringify(task.capabilityIds), task.policyVersion, task.inputReference,
        task.currentStepId ?? null, task.correlationId, task.idempotencyKey, task.createdAt, task.updatedAt]);
    const created = one(result);
    if (!created) throw new SqlRepositoryError('ALREADY_EXISTS', 'Task could not be created.');
    return taskFromRow(created);
  }
  async update(task: Task): Promise<Task> {
    const result = await this.sql.query<Task>(`UPDATE r1_tasks
       SET state=$3, title=$4, goal=$5, capability_ids=$6, policy_version=$7,
           input_reference=$8, current_step_id=$9, updated_at=$10
       WHERE id=$1 AND project_id=$2 RETURNING ${taskColumns}`,
      [task.id, task.projectId, task.state, task.title, task.goal, JSON.stringify(task.capabilityIds),
        task.policyVersion, task.inputReference, task.currentStepId ?? null, task.updatedAt]);
    const updated = one(result);
    if (!updated) throw new SqlRepositoryError('NOT_FOUND', 'Task not found.');
    return taskFromRow(updated);
  }
  async listEvents(projectId: string, taskId: string): Promise<readonly TaskRecordEvent[]> {
    await this.get(projectId, taskId);
    return (await this.sql.query<TaskRecordEvent>(`SELECT id, project_id AS "projectId", task_id AS "taskId",
      event, state, sequence, created_at AS "createdAt" FROM r1_task_events
      WHERE project_id=$1 AND task_id=$2 ORDER BY sequence`, [projectId, taskId])).map(taskEventFromRow);
  }
  async appendEvent(event: TaskRecordEvent): Promise<TaskRecordEvent> {
    // (task_id, sequence) is the immutable natural key. An already-committed
    // event is returned unchanged; an import replay can never silently
    // rewrite history.
    const result = await this.sql.query<TaskRecordEvent>(`INSERT INTO r1_task_events (id, project_id, task_id, event, state, sequence, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (task_id, sequence) DO NOTHING
      RETURNING id, project_id AS "projectId", task_id AS "taskId", event, state, sequence, created_at AS "createdAt"`,
      [event.id, event.projectId, event.taskId, event.event, event.state, event.sequence, event.createdAt]);
    const inserted = one(result);
    if (inserted) return taskEventFromRow(inserted);
    const existing = one(await this.sql.query<TaskRecordEvent>(`SELECT id, project_id AS "projectId", task_id AS "taskId",
      event, state, sequence, created_at AS "createdAt" FROM r1_task_events WHERE task_id=$1 AND sequence=$2`, [event.taskId, event.sequence]));
    if (!existing) throw new SqlRepositoryError('NOT_FOUND', 'Task event could not be appended.');
    return taskEventFromRow(existing);
  }
  async listSteps(projectId: string, taskId: string): Promise<readonly TaskStep[]> {
    await this.get(projectId, taskId);
    return this.sql.query<TaskStep>(`SELECT s.id, s.task_id AS "taskId", s.name, s.state, s.sequence, s.capability_id AS "capabilityId" FROM r1_task_steps s WHERE s.task_id=$1 ORDER BY s.sequence`, [taskId]);
  }
  async saveStep(step: TaskStep): Promise<TaskStep> {
    const result = await this.sql.query<TaskStep>(`INSERT INTO r1_task_steps (id, task_id, name, state, sequence, capability_id) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO UPDATE SET name=$3, state=$4, sequence=$5, capability_id=$6 RETURNING id, task_id AS "taskId", name, state, sequence, capability_id AS "capabilityId"`, [step.id, step.taskId, step.name, step.state, step.sequence, step.capabilityId ?? null]);
    const saved = one(result);
    if (!saved) throw new SqlRepositoryError('NOT_FOUND', 'Task step could not be saved.');
    return saved;
  }
}

class SqlEvidence implements EvidenceRepository {
  constructor(private readonly sql: SqlExecutor) {}
  async append(evidence: Evidence): Promise<Evidence> {
    const result = await this.sql.query<Evidence>(`INSERT INTO r1_evidence (id, project_id, task_id, kind, source, content_hash, metadata, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, project_id AS "projectId", task_id AS "taskId", kind, source, content_hash AS "contentHash", metadata, created_at AS "createdAt"`, [evidence.id, evidence.projectId, evidence.taskId ?? null, evidence.kind, evidence.source, evidence.contentHash, JSON.stringify(evidence.metadata), evidence.createdAt]);
    const saved = one(result);
    if (!saved) throw new SqlRepositoryError('ALREADY_EXISTS', 'Evidence could not be appended.');
    return evidenceFromRow(saved);
  }
  async listForProject(projectId: string): Promise<readonly Evidence[]> {
    return (await this.sql.query<Evidence>(`SELECT id, project_id AS "projectId", task_id AS "taskId", kind, source, content_hash AS "contentHash", metadata, created_at AS "createdAt" FROM r1_evidence WHERE project_id=$1 ORDER BY created_at`, [projectId])).map(evidenceFromRow);
  }
  async listForTask(projectId: string, taskId: string): Promise<readonly Evidence[]> {
    return (await this.sql.query<Evidence>(`SELECT id, project_id AS "projectId", task_id AS "taskId", kind, source, content_hash AS "contentHash", metadata, created_at AS "createdAt" FROM r1_evidence WHERE project_id=$1 AND task_id=$2 ORDER BY created_at`, [projectId, taskId])).map(evidenceFromRow);
  }
}

class SqlMemories implements MemoryRepository {
  constructor(private readonly sql: SqlExecutor) {}
  async get(projectId: string, memoryId: string): Promise<MemoryRecord | null> {
    const memory = one(await this.sql.query<MemoryRecord>(`SELECT id, project_id AS "projectId", content, metadata, evidence_ids AS "evidenceIds", created_at AS "createdAt", updated_at AS "updatedAt" FROM r1_memories WHERE id=$1`, [memoryId]));
    if (memory && memory.projectId !== projectId) throw new SqlRepositoryError('PROJECT_SCOPE_VIOLATION', 'Resource is outside the project scope.');
    return memory ? memoryFromRow(memory) : null;
  }
  async list(projectId: string): Promise<readonly MemoryRecord[]> {
    return (await this.sql.query<MemoryRecord>(`SELECT id, project_id AS "projectId", content, metadata, evidence_ids AS "evidenceIds", created_at AS "createdAt", updated_at AS "updatedAt" FROM r1_memories WHERE project_id=$1 ORDER BY updated_at`, [projectId])).map(memoryFromRow);
  }
  async save(memory: MemoryRecord): Promise<MemoryRecord> {
    const result = await this.sql.query<MemoryRecord>(`INSERT INTO r1_memories (id, project_id, content, metadata, evidence_ids, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO UPDATE SET content=$3, metadata=$4, evidence_ids=$5, updated_at=$7 RETURNING id, project_id AS "projectId", content, metadata, evidence_ids AS "evidenceIds", created_at AS "createdAt", updated_at AS "updatedAt"`, [memory.id, memory.projectId, memory.content, JSON.stringify(memory.metadata), JSON.stringify(memory.evidenceIds), memory.createdAt, memory.updatedAt]);
    const saved = one(result);
    if (!saved) throw new SqlRepositoryError('ALREADY_EXISTS', 'Memory could not be saved.');
    return memoryFromRow(saved);
  }
  async archive(projectId: string, memoryId: string): Promise<void> {
    await this.get(projectId, memoryId);
    await this.sql.query(`DELETE FROM r1_memories WHERE id=$1 AND project_id=$2`, [memoryId, projectId]);
  }
}

class SqlApprovals implements ApprovalRepository {
  constructor(private readonly sql: SqlExecutor) {}
  async get(projectId: string, approvalId: string): Promise<ApprovalRequest | null> {
    const approval = one(await this.sql.query<ApprovalRequest>(`SELECT id, project_id AS "projectId", task_id AS "taskId", capability_id AS "capabilityId", state, created_at AS "createdAt", updated_at AS "updatedAt" FROM r1_approvals WHERE id=$1`, [approvalId]));
    if (approval && approval.projectId !== projectId) throw new SqlRepositoryError('PROJECT_SCOPE_VIOLATION', 'Resource is outside the project scope.');
    return approval ? approvalFromRow(approval) : null;
  }
  async listPending(projectId: string): Promise<readonly ApprovalRequest[]> { return (await this.sql.query<ApprovalRequest>(`SELECT id, project_id AS "projectId", task_id AS "taskId", capability_id AS "capabilityId", state, created_at AS "createdAt", updated_at AS "updatedAt" FROM r1_approvals WHERE project_id=$1 AND state='pending' ORDER BY created_at`, [projectId])).map(approvalFromRow); }
  async create(request: ApprovalRequest): Promise<ApprovalRequest> { const result = await this.sql.query<ApprovalRequest>(`INSERT INTO r1_approvals (id, project_id, task_id, capability_id, state, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, project_id AS "projectId", task_id AS "taskId", capability_id AS "capabilityId", state, created_at AS "createdAt", updated_at AS "updatedAt"`, [request.id, request.projectId, request.taskId, request.capabilityId, request.state, request.createdAt, request.updatedAt]); const created = one(result); if (!created) throw new SqlRepositoryError('ALREADY_EXISTS', 'Approval could not be created.'); return approvalFromRow(created); }
  async update(request: ApprovalRequest): Promise<ApprovalRequest> { const result = await this.sql.query<ApprovalRequest>(`UPDATE r1_approvals SET state=$3, updated_at=$4 WHERE id=$1 AND project_id=$2 RETURNING id, project_id AS "projectId", task_id AS "taskId", capability_id AS "capabilityId", state, created_at AS "createdAt", updated_at AS "updatedAt"`, [request.id, request.projectId, request.state, request.updatedAt]); const updated = one(result); if (!updated) throw new SqlRepositoryError('NOT_FOUND', 'Approval not found.'); return approvalFromRow(updated); }
}

class SqlCapabilities implements CapabilityRepository {
  constructor(private readonly sql: SqlExecutor) {}
  async get(capabilityId: string): Promise<Capability | null> {
    const capability = one(await this.sql.query<Capability>(`SELECT id, name, source, version, owner, scope, risk, enabled FROM r1_capabilities WHERE id=$1`, [capabilityId]));
    return capability ? capabilityFromRow(capability) : null;
  }
  async list(): Promise<readonly Capability[]> {
    return (await this.sql.query<Capability>('SELECT id, name, source, version, owner, scope, risk, enabled FROM r1_capabilities ORDER BY id')).map(capabilityFromRow);
  }
  async save(capability: Capability): Promise<Capability> {
    const result = await this.sql.query<Capability>(`INSERT INTO r1_capabilities (id, name, source, version, owner, scope, risk, enabled) VALUES ($1,$2,$3,$4,$5,$6,$7,CASE WHEN $8::int = 1 THEN TRUE ELSE FALSE END) ON CONFLICT (id) DO UPDATE SET name=$2, version=$4, owner=$5, scope=$6, risk=$7, enabled=CASE WHEN $8::int = 1 THEN TRUE ELSE FALSE END RETURNING id, name, source, version, owner, scope, risk, enabled`, [capability.id, capability.name, capability.source, capability.version, capability.owner, JSON.stringify(capability.scope), capability.risk, capability.enabled ? 1 : 0]);
    const saved = one(result);
    if (!saved) throw new SqlRepositoryError('ALREADY_EXISTS', 'Capability could not be saved.');
    return capabilityFromRow(saved);
  }
}

class SqlReceipts implements ReceiptRepository {
  constructor(private readonly sql: SqlExecutor) {}
  async append(receipt: ActionReceipt): Promise<ActionReceipt> {
    const result = await this.sql.query<ActionReceipt>(`INSERT INTO r1_action_receipts (id, project_id, correlation_id, kind, actor, decision, payload, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7::text::jsonb,$8) RETURNING id, project_id AS "projectId", correlation_id AS "correlationId", kind, actor, decision, payload, created_at AS "createdAt"`, [receipt.id, receipt.projectId, receipt.correlationId, receipt.kind, receipt.actor, receipt.decision, JSON.stringify(receipt.payload), receipt.createdAt]);
    const saved = one(result);
    if (!saved) throw new SqlRepositoryError('ALREADY_EXISTS', 'Receipt could not be appended.');
    return receiptFromRow(saved);
  }
  async listForTask(projectId: string, taskId: string): Promise<readonly ActionReceipt[]> {
    return (await this.sql.query<ActionReceipt>(`SELECT id, project_id AS "projectId", correlation_id AS "correlationId", kind, actor, decision, payload, created_at AS "createdAt" FROM r1_action_receipts WHERE project_id=$1 AND payload->>'taskId'=$2 ORDER BY created_at`, [projectId, taskId])).map(receiptFromRow);
  }
}

/**
 * Factory for the complete persistent R1 repository set. No repository falls
 * back to an in-memory implementation.
 */
export function createSqlR1Repositories(sql: SqlExecutor): R1Repositories {
  return {
    projects: new SqlProjects(sql),
    memories: new SqlMemories(sql),
    tasks: new SqlTasks(sql),
    approvals: new SqlApprovals(sql),
    evidence: new SqlEvidence(sql),
    capabilities: new SqlCapabilities(sql),
    receipts: new SqlReceipts(sql),
  };
}

export type { ApprovalRepository, ApprovalRequest, CapabilityRepository, MemoryRecord, MemoryRepository, ProjectRepository, ReceiptRepository, TaskRepository };
export type { ActionReceipt, ApprovalState, Capability, Evidence, Project, Task, TaskRecordEvent, TaskStep };
