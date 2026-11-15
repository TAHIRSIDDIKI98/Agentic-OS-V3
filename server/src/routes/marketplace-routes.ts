/**
 * Phase 19 — Marketplace REST routes.
 * Mounted at /api/v1/marketplace. Auth + scope enforced per endpoint.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { NexusEnv } from '../lib/hono-env.js';
import { requireScope, safeJson, parse } from '../lib/auth-context.js';
import { ok } from '../lib/envelope.js';
import { marketplaceService } from '../services/marketplace.service.js';
import { meta } from './meta.js';

export const marketplace = new Hono<NexusEnv>();

// Mount the Phase 16/19 developer metadata surface at /marketplace/meta.
marketplace.route('/meta', meta);

// Public catalog reads
marketplace.get('/plugins', async (c) => {
  await requireScope(c, 'marketplace:read');
  const q = c.req.query('q');
  const items = await marketplaceService.listPlugins({
    category: c.req.query('category'),
    kind: c.req.query('kind'),
    q,
    limit: Number(c.req.query('limit') ?? 20),
    offset: Number(c.req.query('offset') ?? 0),
  });
  return c.json(ok({ items, total: items.length }, c.get('requestId') ?? ''));
});

marketplace.get('/plugins/:slug', async (c) => {
  await requireScope(c, 'marketplace:read');
  const p = await marketplaceService.getPlugin(c.req.param('slug'));
  return c.json(ok(p, c.get('requestId') ?? ''));
});

marketplace.get('/integrations', async (c) => {
  await requireScope(c, 'integrations:read');
  const items = await marketplaceService.listIntegrations(c.req.query('kind'));
  return c.json(ok({ items }, c.get('requestId') ?? ''));
});

// Authoring — requires publish scope + ownership checks inside service
marketplace.post('/plugins', async (c) => {
  const p = await requireScope(c, 'marketplace:publish');
  const created = await marketplaceService.publishPlugin(p.id, p.name, await safeJson(c));
  return c.json(ok(created, c.get('requestId') ?? ''), 201);
});

marketplace.post('/plugins/:id/versions', async (c) => {
  const p = await requireScope(c, 'marketplace:publish');
  const body = parse(
    z.object({
      privkeyPem: z.string().min(1),
      pubkeyPem: z.string().min(1),
      version: z.any(),
    }),
    await safeJson(c)
  );
  const created = await marketplaceService.publishVersion(p.id, c.req.param('id'), body.version, {
    privkeyPem: body.privkeyPem,
    pubkeyPem: body.pubkeyPem,
  });
  return c.json(ok(created, c.get('requestId') ?? ''), 201);
});

marketplace.post('/signing-keys', async (c) => {
  const p = await requireScope(c, 'marketplace:publish');
  const body = parse(
    z.object({ pubkeyPem: z.string().min(1), label: z.string().default('default') }),
    await safeJson(c)
  );
  const r = await marketplaceService.registerSigningKey(p.id, body.pubkeyPem, body.label);
  return c.json(ok(r, c.get('requestId') ?? ''), 201);
});

// Reviews
marketplace.post('/plugins/:slug/reviews', async (c) => {
  const p = await requireScope(c, 'marketplace:review');
  const r = await marketplaceService.addReview(
    p.id,
    p.name,
    c.req.param('slug'),
    await safeJson(c)
  );
  return c.json(ok(r, c.get('requestId') ?? ''), 201);
});

// Install / dependency resolution + receipt
marketplace.post('/plugins/:slug/install', async (c) => {
  const p = await requireScope(c, 'marketplace:write');
  const r = await marketplaceService.install(p.id, c.req.param('slug'), await safeJson(c));
  return c.json(ok(r, c.get('requestId') ?? ''), 201);
});

// Security review (Sentinel-owned queue; marketplace:admin-ish via publish scope here for demo)
marketplace.post('/versions/:versionId/approve', async (c) => {
  const p = await requireScope(c, 'marketplace:publish');
  const body = parse(
    z.object({
      score: z.number().int().min(0).max(100),
      findings: z.array(z.unknown()).default([]),
    }),
    await safeJson(c)
  );
  const r = await marketplaceService.approveVersion(
    p.id,
    c.req.param('versionId'),
    body.score,
    body.findings ?? []
  );
  return c.json(ok(r, c.get('requestId') ?? ''));
});

marketplace.post('/integrations', async (c) => {
  const p = await requireScope(c, 'integrations:write');
  const body = parse(
    z.object({
      slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/),
      name: z.string().min(1).max(120),
      description: z.string().max(2000).default(''),
      providerKind: z.string().min(1),
      configSchema: z.record(z.string(), z.unknown()).optional(),
    }),
    await safeJson(c)
  );
  const r = await marketplaceService.createIntegration(p.id, body);
  return c.json(ok(r, c.get('requestId') ?? ''), 201);
});
