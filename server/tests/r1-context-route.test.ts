import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { InMemoryR1Repositories } from '@agentic-os/sdk';
import type { Principal } from '../src/lib/security.js';
import type { NexusEnv } from '../src/lib/hono-env.js';
import { createExtendedR1Router } from '../src/routes/r1-extended.js';
import { createInMemoryExtendedRuntime } from '../src/services/r1-extended-runtime.js';

const principal: Principal = {
  id: 'principal-context',
  name: 'Context route test',
  keyHash: 'not-used-in-test',
  scopes: ['memory:read', 'memory:write', 'brain:admin'],
  status: 'active',
};

const project = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'context-route',
  mode: 'local' as const,
  scope: { root: '/tmp/context-route' },
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
};

async function createApp() {
  const repositories = new InMemoryR1Repositories();
  await repositories.projects.create(project);
  await repositories.memories.save({
    id: '33333333-3333-4333-8333-333333333331',
    projectId: project.id,
    content: 'Token rotation happens every 15 minutes.',
    metadata: {
      provenance: {
        type: 'fact',
        source: 'route-test',
        confidence: 0.9,
        lifecycle: 'active',
        evidenceIds: ['eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1'],
      },
    },
    evidenceIds: ['eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1'],
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  });
  const runtime = createInMemoryExtendedRuntime(repositories);
  const app = new Hono<NexusEnv>();
  app.use('*', async (c, next) => {
    c.set('principal', principal);
    await next();
  });
  app.route('/api/v1/r1', createExtendedR1Router(runtime));
  return app;
}

describe('context pack route', () => {
  it('returns a bounded pack with citations', async () => {
    const app = await createApp();
    const response = await app.request(
      `/api/v1/r1/projects/${project.id}/context?tokenBudget=2000&focus=token%20rotation`
    );
    expect(response.status).toBe(200);
    const pack = (await response.json()) as {
      budgetRequested: number;
      budgetUsed: number;
      sections: Array<{ id: string; items: unknown[] }>;
      citations: string[];
    };
    expect(pack.budgetRequested).toBe(2000);
    expect(pack.budgetUsed).toBeLessThanOrEqual(2000);
    expect(pack.sections.find((section) => section.id === 'memory')?.items.length).toBe(1);
    expect(pack.citations).toContain('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1');
  });

  it('rejects invalid budgets before building a pack', async () => {
    const app = await createApp();
    const response = await app.request(`/api/v1/r1/projects/${project.id}/context?tokenBudget=10`);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'INVALID' },
    });
  });

  it('returns 404 semantics for an unknown project', async () => {
    const app = await createApp();
    const response = await app.request(
      `/api/v1/r1/projects/99999999-9999-4999-8999-999999999999/context`
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'PROJECT_NOT_FOUND' },
    });
  });
});
