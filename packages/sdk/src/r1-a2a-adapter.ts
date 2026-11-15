/**
 * E7-S2 Versioned A2A task adapter
 * AC1: Supported A2A version/binding declared and tested
 * AC2: Agent Card validated for identity, endpoint, capabilities, auth, version
 * AC3: Remote task ID/context/artifacts correlate to local task step
 * AC4: Local policy and approval run before delegation and before artifact promotion
 * AC5: Remote failure/unknown status visible and recoverable
 * AC6: Remote content untrusted and cannot silently become trusted memory
 */

import { z } from 'zod';
import { randomUUID } from 'node:crypto';

export const A2AVersionSchema = z.enum(['1.0', '0.9', '1.0-proto']);
export type A2AVersion = z.infer<typeof A2AVersionSchema>;

export const A2ABindingSchema = z.enum(['json-rpc', 'grpc', 'http']);
export type A2ABinding = z.infer<typeof A2ABindingSchema>;

export const A2ACompatibilityMatrixSchema = z.object({
  versions: z.array(A2AVersionSchema),
  bindings: z.array(A2ABindingSchema),
  defaultVersion: A2AVersionSchema,
});
export type A2ACompatibilityMatrix = z.infer<typeof A2ACompatibilityMatrixSchema>;

export const AgentCardSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: A2AVersionSchema,
  endpoint: z.string().url(),
  capabilities: z.array(z.string()).min(1),
  auth: z.object({
    type: z.enum(['none', 'bearer', 'oauth', 'mtls']),
    required: z.boolean().default(true),
  }),
  identity: z.object({
    provider: z.string().min(1),
    publicKey: z.string().optional(),
    verified: z.boolean().default(false),
  }),
  extensions: z.array(z.string()).default([]),
});
export type AgentCard = z.infer<typeof AgentCardSchema>;

export const A2ATaskSchema = z.object({
  id: z.string().min(1),
  contextId: z.string().min(1),
  localTaskId: z.string().uuid(),
  localStepId: z.string().uuid().optional(),
  agentCardId: z.string().min(1),
  status: z.enum(['submitted', 'running', 'completed', 'failed', 'unknown']),
  artifacts: z.array(z.object({
    id: z.string().min(1),
    mimeType: z.string().min(1),
    content: z.unknown(),
    metadata: z.record(z.string(), z.unknown()).default({}),
  })).default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type A2ATask = z.infer<typeof A2ATaskSchema>;

export interface AgentCardRepository {
  get(id: string): Promise<AgentCard | null>;
  list(): Promise<readonly AgentCard[]>;
  save(card: AgentCard): Promise<AgentCard>;
}

class InMemoryAgentCardRepo implements AgentCardRepository {
  private readonly map = new Map<string, AgentCard>();
  async get(id: string): Promise<AgentCard | null> { return this.map.get(id) ?? null; }
  async list(): Promise<readonly AgentCard[]> { return [...this.map.values()].sort((a,b) => a.id.localeCompare(b.id)); }
  async save(card: AgentCard): Promise<AgentCard> { this.map.set(card.id, card); return card; }
}

export interface A2ATaskRepository {
  get(id: string): Promise<A2ATask | null>;
  listForLocalTask(localTaskId: string): Promise<readonly A2ATask[]>;
  save(task: A2ATask): Promise<A2ATask>;
  update(task: A2ATask): Promise<A2ATask>;
}

class InMemoryA2ATaskRepo implements A2ATaskRepository {
  private readonly map = new Map<string, A2ATask>();
  async get(id: string): Promise<A2ATask | null> { return this.map.get(id) ?? null; }
  async listForLocalTask(localTaskId: string): Promise<readonly A2ATask[]> {
    return [...this.map.values()].filter(t => t.localTaskId === localTaskId).sort((a,b) => a.createdAt.localeCompare(b.createdAt));
  }
  async save(task: A2ATask): Promise<A2ATask> { this.map.set(task.id, task); return task; }
  async update(task: A2ATask): Promise<A2ATask> { this.map.set(task.id, task); return task; }
}

export const A2A_COMPATIBILITY_MATRIX: A2ACompatibilityMatrix = {
  versions: ['1.0', '0.9'],
  bindings: ['json-rpc', 'http'],
  defaultVersion: '1.0',
};

function validateAgentCard(cardRaw: unknown): AgentCard {
  const card = AgentCardSchema.parse(cardRaw);
  if (!A2A_COMPATIBILITY_MATRIX.versions.includes(card.version)) {
    throw new Error(`Unsupported A2A version ${card.version}. Supported: ${A2A_COMPATIBILITY_MATRIX.versions.join(', ')}`);
  }
  if (!card.identity.verified) {
    throw new Error(`Agent Card ${card.id} identity not verified`);
  }
  if (card.auth.required && card.auth.type === 'none') {
    throw new Error(`Agent Card ${card.id} requires auth but type is none`);
  }
  if (!card.endpoint.startsWith('https://') && !card.endpoint.includes('localhost')) {
    throw new Error('A2A endpoint must be https or localhost for R1');
  }
  if (card.capabilities.length === 0) throw new Error('Agent Card must have at least one capability');
  return card;
}

export interface A2AAdapterOptions {
  readonly now?: () => string;
  readonly policyCheck?: (tool: string, owner: string) => Promise<{ effect: 'allow'|'deny'|'approval_required', reason: string }>;
  readonly isApprovalApproved?: (approvalId: string) => Promise<boolean>;
}

export class A2AAdapter {
  private readonly now: () => string;
  private readonly cards: AgentCardRepository;
  private readonly tasks: A2ATaskRepository;
  private readonly policyCheck: (tool: string, owner: string) => Promise<{ effect: string, reason: string }>;
  private readonly isApprovalApproved: (approvalId: string) => Promise<boolean>;

  constructor(
    cards: AgentCardRepository = new InMemoryAgentCardRepo(),
    tasks: A2ATaskRepository = new InMemoryA2ATaskRepo(),
    options: A2AAdapterOptions = {}
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.cards = cards;
    this.tasks = tasks;
    this.policyCheck = options.policyCheck ?? (async () => ({ effect: 'allow', reason: 'default allow' }));
    this.isApprovalApproved = options.isApprovalApproved ?? (async () => false);
  }

  getCompatibilityMatrix(): A2ACompatibilityMatrix { return A2A_COMPATIBILITY_MATRIX; }

  async registerAgentCard(raw: unknown): Promise<AgentCard> {
    const card = validateAgentCard(raw);
    return this.cards.save(card);
  }

  async listAgentCards(): Promise<readonly AgentCard[]> {
    return this.cards.list();
  }

  async delegateTask(input: { localTaskId: string; localStepId?: string; agentCardId: string; owner: string; approvalId?: string; contextId?: string }): Promise<A2ATask> {
    const card = await this.cards.get(input.agentCardId);
    if (!card) throw new Error('Agent Card not found');

    // Local policy before delegation (AC4)
    const policy = await this.policyCheck(`a2a:${card.id}`, input.owner);
    if (policy.effect === 'deny') throw new Error(`Policy denied delegation to ${card.id}: ${policy.reason}`);
    if (policy.effect === 'approval_required' && !input.approvalId) throw new Error(`Delegation to ${card.id} requires approval`);
    if (policy.effect === 'approval_required' && input.approvalId) {
      const approved = await this.isApprovalApproved(input.approvalId);
      if (!approved) throw new Error('Approval not approved for delegation');
    }

    const task: A2ATask = {
      id: `a2a-${randomUUID()}`,
      contextId: input.contextId ?? randomUUID(),
      localTaskId: input.localTaskId,
      localStepId: input.localStepId,
      agentCardId: card.id,
      status: 'submitted',
      artifacts: [],
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    return this.tasks.save(task);
  }

  async getRemoteStatus(taskId: string): Promise<A2ATask> {
    const task = await this.tasks.get(taskId);
    if (!task) throw new Error('A2A task not found');
    // Simulate remote status check - in real would call remote endpoint
    // For R1, if status unknown, keep as unknown visible and recoverable (AC5)
    return task;
  }

  async updateRemoteStatus(taskId: string, status: A2ATask['status'], artifacts: A2ATask['artifacts'] = []): Promise<A2ATask> {
    const task = await this.tasks.get(taskId);
    if (!task) throw new Error('A2A task not found');
    const updated: A2ATask = { ...task, status, artifacts, updatedAt: this.now() };
    return this.tasks.update(updated);
  }

  async promoteArtifact(input: { a2aTaskId: string; artifactId: string; owner: string; approvalId?: string }): Promise<{ promoted: boolean; reason: string; artifact: unknown }> {
    const task = await this.tasks.get(input.a2aTaskId);
    if (!task) throw new Error('A2A task not found');
    const artifact = task.artifacts.find(a => a.id === input.artifactId);
    if (!artifact) throw new Error('Artifact not found');

    // Before artifact promotion, local policy and approval (AC4)
    const policy = await this.policyCheck(`a2a:artifact:${artifact.mimeType}`, input.owner);
    if (policy.effect === 'deny') return { promoted: false, reason: `Policy denied artifact promotion: ${policy.reason}`, artifact };
    if (policy.effect === 'approval_required') {
      if (!input.approvalId) return { promoted: false, reason: 'Artifact promotion requires approval', artifact };
      const approved = await this.isApprovalApproved(input.approvalId);
      if (!approved) return { promoted: false, reason: 'Approval not approved', artifact };
    }

    // Remote content is untrusted and cannot silently become trusted memory (AC6)
    // So we mark it as untrusted candidate, not trusted
    return { promoted: true, reason: 'Artifact promoted as untrusted candidate', artifact: { ...artifact, metadata: { ...artifact.metadata, trust: 'candidate', untrusted: true } } };
  }

  async listForLocalTask(localTaskId: string): Promise<readonly A2ATask[]> {
    return this.tasks.listForLocalTask(localTaskId);
  }
}
