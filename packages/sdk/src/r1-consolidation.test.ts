import { describe, expect, it } from 'vitest';
import { ContextPackService } from './r1-context-pack.js';
import { ConsolidationError, TaskConsolidationService } from './r1-consolidation.js';
import { InMemoryR1Repositories } from './in-memory-repositories.js';
import { TaskWorker } from './r1-task-worker.js';
import type { MemoryRecord, Project, Task } from './index.js';

const timestamp = '2026-11-01T00:00:00.000Z';
const now = () => '2026-11-15T12:00:00.000Z';

const project: Project = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'consolidation-demo',
  mode: 'local',
  scope: { root: '/tmp/consolidation-demo' },
  createdAt: timestamp,
  updatedAt: timestamp,
};

const task = (state: Task['state']): Task => ({
  id: '44444444-4444-4444-8444-444444444441',
  projectId: project.id,
  principalId: 'principal-test',
  agentId: 'agent-test',
  state,
  title: 'Harden token rotation',
  goal: 'Rotate credentials every 15 minutes',
  capabilityIds: [],
  policyVersion: 'policy-r1',
  inputReference: 'input:test',
  correlationId: '22222222-2222-4222-8222-222222222222',
  idempotencyKey: 'task-consolidation',
  createdAt: timestamp,
  updatedAt: timestamp,
});

async function seed(state: Task['state'] = 'completed') {
  const repositories = new InMemoryR1Repositories();
  await repositories.projects.create(project);
  await repositories.tasks.create(task(state));
  await repositories.tasks.appendEvent({
    id: '55555555-5555-4555-8555-555555555551',
    projectId: project.id,
    taskId: task(state).id,
    event: 'complete',
    state: 'completed',
    sequence: 1,
    createdAt: timestamp,
  });
  return repositories;
}

describe('TaskConsolidationService', () => {
  it('turns a completed task into an evidence-backed active memory', async () => {
    const repositories = await seed();
    const service = new TaskConsolidationService(repositories, { now });
    const result = await service.consolidateTask(project.id, task('completed').id);

    expect(result.created).toHaveLength(1);
    expect(result.created[0]?.lifecycle).toBe('active');
    expect(result.evidenceIds).toHaveLength(1);

    const evidence = await repositories.evidence.listForTask(project.id, task('completed').id);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.contentHash).toMatch(/^[a-f0-9]{64}$/);

    const memories = await repositories.memories.list(project.id);
    expect(memories).toHaveLength(1);
    expect(memories[0]?.content).toContain('Harden token rotation');
    expect(memories[0]?.evidenceIds).toEqual(result.evidenceIds);
    expect(
      (memories[0]?.metadata as { provenance: { confidence: number } }).provenance.confidence
    ).toBe(0.9);
  });

  it('stores agent-supplied learnings with their declared type and confidence', async () => {
    const repositories = await seed();
    const service = new TaskConsolidationService(repositories, { now });
    const result = await service.consolidateTask(project.id, task('completed').id, {
      statements: [
        {
          text: 'Token rotation is owned by the scheduler, not the API layer.',
          type: 'decision',
          confidence: 0.95,
        },
        { text: 'Possible duplicate scheduler pointer.', type: 'fact', confidence: 0.2 },
      ],
    });

    expect(result.created).toHaveLength(3);
    expect(result.created.filter((entry) => entry.lifecycle === 'candidate')).toHaveLength(1);
    const memories = await repositories.memories.list(project.id);
    const decision = memories.find((memory) => memory.content.includes('owned by the scheduler'));
    expect((decision?.metadata as { provenance: { type: string } }).provenance.type).toBe(
      'decision'
    );
  });

  it('is idempotent: re-running reports duplicates and creates nothing', async () => {
    const repositories = await seed();
    const service = new TaskConsolidationService(repositories, { now });
    await service.consolidateTask(project.id, task('completed').id, {
      statements: [{ text: 'Rotation interval is fifteen minutes.', type: 'fact' }],
    });
    const before = await repositories.memories.list(project.id);
    const second = await service.consolidateTask(project.id, task('completed').id, {
      statements: [{ text: 'Rotation interval is fifteen minutes.', type: 'fact' }],
    });

    expect(second.created).toHaveLength(0);
    expect(second.duplicates.length).toBeGreaterThanOrEqual(2);
    await expect(repositories.memories.list(project.id)).resolves.toHaveLength(before.length);
  });

  it('does not duplicate a near-identical existing memory', async () => {
    const repositories = await seed();
    const existing: MemoryRecord = {
      id: '33333333-3333-4333-8333-333333333331',
      projectId: project.id,
      content: 'Task "Harden token rotation" completed; goal: Rotate credentials every 15 minutes.',
      metadata: {
        provenance: {
          type: 'fact',
          source: 'manual',
          confidence: 0.9,
          lifecycle: 'active',
          evidenceIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
        },
      },
      evidenceIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await repositories.memories.save(existing);
    const service = new TaskConsolidationService(repositories, { now });
    const result = await service.consolidateTask(project.id, task('completed').id);

    expect(result.created).toHaveLength(0);
    expect(result.duplicates[0]?.memoryId).toBe(existing.id);
  });

  it('refuses tasks that are not completed', async () => {
    const repositories = await seed('running');
    const service = new TaskConsolidationService(repositories, { now });
    await expect(service.consolidateTask(project.id, task('running').id)).rejects.toMatchObject({
      code: 'TASK_NOT_COMPLETED',
    });
    await expect(service.consolidateTask(project.id, task('running').id)).rejects.toBeInstanceOf(
      ConsolidationError
    );
  });

  it('reports unknown projects and tasks', async () => {
    const repositories = await seed();
    const service = new TaskConsolidationService(repositories, { now });
    await expect(
      service.consolidateTask('99999999-9999-4999-8999-999999999999', task('completed').id)
    ).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
    await expect(
      service.consolidateTask(project.id, '99999999-9999-4999-8999-999999999998')
    ).rejects.toMatchObject({ code: 'TASK_NOT_FOUND' });
  });

  it('skips empty, over-long and over-limit statements', async () => {
    const repositories = await seed();
    const service = new TaskConsolidationService(repositories, { now });
    const result = await service.consolidateTask(project.id, task('completed').id, {
      maxStatements: 1,
      statements: [
        { text: '   ' },
        { text: 'x'.repeat(2001) },
        { text: 'Kept statement one.' },
        { text: 'Dropped by the limit.' },
      ],
    });

    expect(result.skipped.map((entry) => entry.reason).sort()).toEqual([
      'empty',
      'over_limit',
      'too_long',
    ]);
    expect(result.created).toHaveLength(2);
    expect(result.created.map((entry) => entry.text)).toEqual([
      expect.stringContaining('Harden token rotation'),
      'Kept statement one.',
    ]);
  });

  it('consolidates automatically when the worker completes a task', async () => {
    const repositories = await seed('running');
    const worker = new TaskWorker(repositories, undefined, undefined, undefined, {
      now,
      onCompleted: async (projectId, taskId) => {
        await new TaskConsolidationService(repositories, { now }).consolidateTask(
          projectId,
          taskId
        );
      },
    });
    await worker.transition(project.id, task('running').id, 'complete');

    const memories = await repositories.memories.list(project.id);
    expect(memories.map((memory) => memory.content)).toEqual(
      expect.arrayContaining([expect.stringContaining('Harden token rotation')])
    );
  });

  it('keeps the completion durable when the hook fails', async () => {
    const repositories = await seed('running');
    const failures: string[] = [];
    const worker = new TaskWorker(repositories, undefined, undefined, undefined, {
      now,
      onCompleted: async () => {
        throw new Error('memory store unavailable');
      },
      onCompletedError: (error, _projectId, taskId) => {
        failures.push(`${taskId}:${(error as Error).message}`);
      },
    });
    const completed = await worker.transition(project.id, task('running').id, 'complete');

    expect(completed.state).toBe('completed');
    expect(failures).toEqual([`${task('running').id}:memory store unavailable`]);
  });

  it('feeds the next context pack', async () => {
    const repositories = await seed();
    await new TaskConsolidationService(repositories, { now }).consolidateTask(
      project.id,
      task('completed').id,
      { statements: [{ text: 'Rotation is scheduled by the kernel worker.', type: 'decision' }] }
    );
    const pack = await new ContextPackService(repositories, { now }).build(project.id, {
      tokenBudget: 2000,
      focus: 'rotation scheduled',
    });
    const memories = pack.sections
      .filter((section) => section.id === 'memory')
      .flatMap((section) => section.items);
    expect(memories.map((item) => item.text)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Rotation is scheduled by the kernel worker'),
      ])
    );
    expect(pack.citations.length).toBeGreaterThan(0);
  });
});
