import { describe, expect, it } from 'vitest';
import { InMemoryR1Repositories } from './in-memory-repositories.js';
import { ContextPackService } from './r1-context-pack.js';
import type { MemoryRecord, Project, Task } from './index.js';

const timestamp = '2026-11-01T00:00:00.000Z';
const now = () => '2026-11-15T12:00:00.000Z';

const project: Project = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'context-pack-demo',
  mode: 'local',
  scope: { root: '/tmp/context-pack-demo' },
  createdAt: timestamp,
  updatedAt: timestamp,
};

const memory = (
  id: string,
  content: string,
  lifecycle: 'active' | 'archived' | 'forgotten' | 'candidate',
  evidenceIds: string[] = []
): MemoryRecord => ({
  id,
  projectId: project.id,
  content,
  metadata: {
    provenance: {
      type: 'fact' as const,
      source: 'test',
      confidence: 0.9,
      lifecycle,
      evidenceIds: evidenceIds.length ? evidenceIds : ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
    },
  },
  evidenceIds: evidenceIds.length ? evidenceIds : ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
  createdAt: timestamp,
  updatedAt: timestamp,
});

const task = (id: string, state: Task['state'], title: string): Task => ({
  id,
  projectId: project.id,
  principalId: 'principal-test',
  agentId: 'agent-test',
  state,
  title,
  goal: `${title} goal`,
  capabilityIds: [],
  policyVersion: 'policy-r1',
  inputReference: 'input:test',
  correlationId: '22222222-2222-4222-8222-222222222222',
  idempotencyKey: `task-${id}`,
  createdAt: timestamp,
  updatedAt: timestamp,
});

async function seed() {
  const repositories = new InMemoryR1Repositories();
  await repositories.projects.create(project);
  await repositories.memories.save(
    memory(
      '33333333-3333-4333-8333-333333333331',
      'Token rotation happens every 15 minutes.',
      'active',
      ['eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1']
    )
  );
  await repositories.memories.save(
    memory('33333333-3333-4333-8333-333333333332', 'The dashboard uses a dark theme.', 'active', [
      'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2',
    ])
  );
  await repositories.memories.save(
    memory('33333333-3333-4333-8333-333333333333', 'Old token scheme was deprecated.', 'archived')
  );
  await repositories.memories.save(
    memory('33333333-3333-4333-8333-333333333334', 'Forgotten secret.', 'forgotten')
  );
  await repositories.tasks.create(
    task('44444444-4444-4444-8444-444444444441', 'queued', 'Refactor tokens')
  );
  await repositories.tasks.create(
    task('44444444-4444-4444-8444-444444444442', 'completed', 'Old work')
  );
  await repositories.approvals.create({
    id: '55555555-5555-4555-8555-555555555551',
    projectId: project.id,
    taskId: '44444444-4444-4444-8444-444444444441',
    capabilityId: 'file.write',
    state: 'pending',
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  return repositories;
}

describe('ContextPackService', () => {
  it('packs project, open tasks, pending approvals and active memories under budget', async () => {
    const service = new ContextPackService(await seed(), { now });
    const pack = await service.build(project.id, { tokenBudget: 2000, focus: 'token rotation' });

    expect(pack.budgetUsed).toBeLessThanOrEqual(2000);
    expect(pack.generatedAt).toBe(now());
    const kinds = pack.sections.flatMap((section) => section.items.map((item) => item.kind));
    expect(kinds).toContain('project');
    expect(kinds).toContain('task');
    expect(kinds).toContain('approval');
    expect(kinds).toContain('memory');

    const items = pack.sections.flatMap((section) => section.items);
    const tokens = items.reduce((total, item) => total + item.tokens, 0);
    expect(tokens).toBe(pack.budgetUsed);
  });

  it('excludes archived/forgotten memories and terminal tasks', async () => {
    const service = new ContextPackService(await seed(), { now });
    const pack = await service.build(project.id, { tokenBudget: 5000 });
    const text = pack.sections
      .flatMap((section) => section.items.map((item) => item.text))
      .join('\n');

    expect(text).not.toContain('Old token scheme was deprecated');
    expect(text).not.toContain('Forgotten secret');
    expect(text).not.toContain('Old work');
    expect(text).toContain('Token rotation happens');
  });

  it('ranks focus-relevant memories first and preserves evidence citations', async () => {
    const service = new ContextPackService(await seed(), { now });
    const pack = await service.build(project.id, { tokenBudget: 5000, focus: 'token rotation' });
    const memories = pack.sections
      .filter((section) => section.id === 'memory')
      .flatMap((section) => section.items);

    expect(memories[0]?.text).toContain('Token rotation');
    expect(pack.citations).toEqual(
      expect.arrayContaining([
        'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1',
        'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2',
      ])
    );
    expect(memories[0]?.evidenceIds).toEqual(['eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1']);
  });

  it('reports truncation explicitly when the budget is too small', async () => {
    const service = new ContextPackService(await seed(), { now });
    const pack = await service.build(project.id, { tokenBudget: 5 });

    expect(pack.budgetUsed).toBe(0);
    expect(pack.truncated).toBe(true);
    expect(pack.sections.every((section) => section.items.length === 0)).toBe(true);
    expect(pack.sections.reduce((total, section) => total + section.omitted, 0)).toBeGreaterThan(0);
  });

  it('rejects unknown projects and non-positive budgets', async () => {
    const service = new ContextPackService(await seed(), { now });
    await expect(
      service.build('99999999-9999-4999-8999-999999999999', { tokenBudget: 100 })
    ).rejects.toThrow('Project not found');
    await expect(service.build(project.id, { tokenBudget: 0 })).rejects.toThrow(
      'tokenBudget must be a positive integer'
    );
  });

  it('uses a durable approval provider when one is supplied', async () => {
    const repositories = await seed();
    const service = new ContextPackService(repositories, {
      now,
      listApprovals: async () => [
        {
          id: '66666666-6666-4666-8666-666666666661',
          taskId: '44444444-4444-4444-8444-444444444441',
          capabilityId: 'shell.exec',
          state: 'pending',
          createdAt: timestamp,
        },
        {
          id: '66666666-6666-4666-8666-666666666662',
          taskId: '44444444-4444-4444-8444-444444444441',
          capabilityId: 'file.write',
          state: 'approved',
          createdAt: timestamp,
        },
      ],
    });
    const pack = await service.build(project.id, { tokenBudget: 5000 });
    const approvals = pack.sections
      .filter((section) => section.id === 'approval')
      .flatMap((section) => section.items);
    expect(approvals.map((item) => item.text)).toEqual([expect.stringContaining('shell.exec')]);
  });
});
