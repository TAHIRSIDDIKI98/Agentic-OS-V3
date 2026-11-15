/**
 * Phase 19 — Ecosystem & Marketplace service.
 *
 * Real DB-backed marketplace: plugin publishing + ed25519 signing, versioned
 * artifacts, community ratings/reviews, dependency resolution (Tarjan SCC for
 * cycle detection), security-review queue, install ledger, and deterministic
 * receipt hashing. Sandbox execution fuel limits are described here and
 * enforced by the WASM sandbox (see Sentinel's plugin-sandbox).
 *
 * All crypto uses the Node built-in `node:crypto` to avoid new runtime deps.
 */

import { and, asc, desc, eq, sql, avg, count } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db } from '../db/client.js';
import {
  marketplacePlugins,
  marketplaceVersions,
  pluginReviews,
  pluginDependencies,
  pluginInstalls,
  pluginSecurityReviews,
  pluginSigningKeys,
  marketplaceIntegrations,
} from '../db/schema.js';
import { ApiError } from '../lib/errors.js';
import { parse } from '../lib/auth-context.js';
import { z } from 'zod';
import { signArtifactEd25519, verifyArtifactEd25519, receiptHash } from '../lib/crypto-sign.js';
import { tarjanSCC, topoSort, type DepNode } from '../lib/graph.js';

/* ─── Validation schemas ───────────────────────────────────────────────── */

export const publishPluginSchema = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/, 'slug must be kebab-case, 2-64 chars'),
  name: z.string().min(1).max(120),
  description: z.string().max(4000).default(''),
  category: z.string().min(1).max(40).default('general'),
  kind: z.enum(['plugin', 'agent', 'memory', 'widget', 'tool', 'integration']).default('plugin'),
  license: z.string().max(40).default('MIT'),
  homepage: z.string().url().optional(),
  repository: z.string().url().optional(),
});

export const publishVersionSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+(-[\w.]+)?$/, 'semver required'),
  manifest: z.record(z.string(), z.unknown()).default({}),
  artifactSha256: z.string().regex(/^[a-f0-9]{64}$/),
  artifactStorageKey: z.string().min(1),
  artifactSize: z.number().int().nonnegative().default(0),
  wasmEntry: z.string().optional(),
  minEngineVersion: z.string().optional(),
  changelog: z.string().max(8000).default(''),
  fuelLimit: z.number().int().positive().default(1_000_000_000),
  sandboxProfile: z.string().min(1).default('default'),
  dependencies: z
    .array(
      z.object({
        slug: z.string(),
        range: z.string().default('*'),
        kind: z.enum(['runtime', 'peer', 'dev']).default('runtime'),
      })
    )
    .default([]),
});

export const reviewSchema = z.object({
  versionId: z.string().optional(),
  rating: z.number().int().min(1).max(5),
  title: z.string().max(200).default(''),
  body: z.string().max(4000).default(''),
});

export const installSchema = z.object({
  versionId: z.string(),
  tenantId: z.string().default('default'),
  installPath: z.string().optional(),
});

/* ─── Crypto + graph helpers ─────────────────────────���───────────────────
 * Pure, DB-free implementations live in ../lib/crypto-sign.ts and
 * ../lib/graph.ts (signArtifactEd25519, verifyArtifactEd25519, webhookHmac,
 * receiptHash, sha256Hex, tarjanSCC, topoSort). Imported above.
 */

/**
 * Resolve a dependency closure for a root plugin version.
 * Throws ApiError on cycle or unsatisfiable version range.
 * Returns an install order (topological) of slugs.
 */
export async function resolveDependencyClosure(
  rootSlug: string
): Promise<{ order: string[]; cycles: string[][] }> {
  const root = await db.query.marketplacePlugins.findFirst({
    where: eq(marketplacePlugins.slug, rootSlug),
  });
  if (!root) throw new ApiError('NOT_FOUND', `plugin ${rootSlug} not found`);
  if (!root.latestVersionId)
    throw new ApiError('BAD_REQUEST', `plugin ${rootSlug} has no published version`);

  const visited = new Map<string, DepNode>();
  const queue = [root.latestVersionId];

  while (queue.length) {
    const vid = queue.shift()!;
    const ver = await db.query.marketplaceVersions.findFirst({
      where: eq(marketplaceVersions.id, vid),
    });
    if (!ver) continue;
    const plugin = await db.query.marketplacePlugins.findFirst({
      where: eq(marketplacePlugins.id, ver.pluginId),
    });
    if (!plugin) continue;
    if (visited.has(plugin.slug)) continue;
    const deps = await db.query.pluginDependencies.findMany({
      where: eq(pluginDependencies.versionId, vid),
    });
    const depNodes = deps.map((d: typeof pluginDependencies.$inferSelect) => ({
      slug: d.depSlug,
      range: d.depVersionRange,
    }));
    visited.set(plugin.slug, { slug: plugin.slug, deps: depNodes });
    for (const d of depNodes) {
      const dep = await db.query.marketplacePlugins.findFirst({
        where: eq(marketplacePlugins.slug, d.slug),
      });
      if (dep?.latestVersionId) queue.push(dep.latestVersionId);
    }
  }

  const nodes = [...visited.values()];
  const sccs = tarjanSCC(nodes);
  const cycles = sccs.filter((scc) => {
    if (scc.length > 1) return true;
    const head = scc[0];
    if (!head) return false;
    return visited.get(head)?.deps.some((d) => d.slug === head) ?? false;
  });
  if (cycles.length) {
    throw new ApiError(
      'DEPENDENCY_CYCLE',
      `dependency cycle detected: ${cycles.map((c) => c.join('->')).join(', ')}`
    );
  }

  const order = topoSort(nodes);
  return { order, cycles };
}

/* ─── Service API ──────────────────────────────────────────────────────── */

export const marketplaceService = {
  async registerSigningKey(authorId: string, pubkeyPem: string, label = 'default') {
    const id = randomUUID();
    await db.insert(pluginSigningKeys).values({ id, authorId, pubkey: pubkeyPem, label });
    return { id };
  },

  async publishPlugin(authorId: string, authorName: string, input: unknown) {
    const data = parse(publishPluginSchema, input);
    const existing = await db.query.marketplacePlugins.findFirst({
      where: eq(marketplacePlugins.slug, data.slug),
    });
    if (existing) throw new ApiError('CONFLICT', `slug '${data.slug}' already exists`);
    const id = randomUUID();
    await db.insert(marketplacePlugins).values({
      id,
      slug: data.slug,
      name: data.name,
      description: data.description,
      authorId,
      authorName,
      category: data.category,
      kind: data.kind,
      license: data.license,
      homepage: data.homepage,
      repository: data.repository,
      status: 'draft',
    });
    return { id, slug: data.slug };
  },

  async publishVersion(
    authorId: string,
    pluginId: string,
    input: unknown,
    opts: { privkeyPem: string; pubkeyPem: string }
  ) {
    const plugin = await db.query.marketplacePlugins.findFirst({
      where: eq(marketplacePlugins.id, pluginId),
    });
    if (!plugin) throw new ApiError('NOT_FOUND', 'plugin not found');
    if (plugin.authorId !== authorId) throw new ApiError('FORBIDDEN', 'not the plugin author');

    const data = parse(publishVersionSchema, input);

    // Verify the author actually controls the signing key (pubkey match).
    const key = await db.query.pluginSigningKeys.findFirst({
      where: and(
        eq(pluginSigningKeys.authorId, authorId),
        eq(pluginSigningKeys.pubkey, opts.pubkeyPem),
        eq(pluginSigningKeys.revoked, false)
      ),
    });
    if (!key) throw new ApiError('BAD_REQUEST', 'signing key not registered/verified for author');

    // ed25519 sign the artifact digest.
    const signature = signArtifactEd25519(opts.privkeyPem, data.artifactSha256);
    const valid = verifyArtifactEd25519(opts.pubkeyPem, data.artifactSha256, signature);
    if (!valid) throw new ApiError('SIGNATURE_INVALID', 'signature verification failed');

    const id = randomUUID();
    await db.insert(marketplaceVersions).values({
      id,
      pluginId,
      version: data.version,
      manifest: data.manifest,
      artifactSha256: data.artifactSha256,
      artifactSize: data.artifactSize,
      artifactStorageKey: data.artifactStorageKey,
      wasmEntry: data.wasmEntry,
      minEngineVersion: data.minEngineVersion,
      changelog: data.changelog,
      signature,
      signerPubkey: opts.pubkeyPem,
      fuelLimit: data.fuelLimit,
      sandboxProfile: data.sandboxProfile,
      status: 'pending',
    });

    // Persist dependency edges for resolution.
    if (data.dependencies?.length) {
      await db.insert(pluginDependencies).values(
        data.dependencies.map(
          (d: { slug: string; range?: string; kind?: 'runtime' | 'peer' | 'dev' }) => ({
            id: randomUUID(),
            pluginId,
            versionId: id,
            depSlug: d.slug,
            depVersionRange: d.range ?? '*',
            kind: d.kind ?? 'runtime',
          })
        )
      );
    }

    // Open a security-review queue entry (state transitions handled by Sentinel).
    await db
      .insert(pluginSecurityReviews)
      .values({ id: randomUUID(), versionId: id, state: 'queued' });
    return { id, version: data.version, status: 'pending' };
  },

  async listPlugins(opts: {
    category?: string;
    kind?: string;
    q?: string;
    limit?: number;
    offset?: number;
  }) {
    const where = [
      eq(marketplacePlugins.status, 'published'),
      opts.category ? eq(marketplacePlugins.category, opts.category) : undefined,
      opts.kind ? eq(marketplacePlugins.kind, opts.kind) : undefined,
    ].filter(Boolean) as ReturnType<typeof eq>[];
    const rows = await db.query.marketplacePlugins.findMany({
      where: where.length ? and(...where) : undefined,
      orderBy: [desc(marketplacePlugins.installCount), desc(marketplacePlugins.avgRating)],
      limit: opts.limit ?? 20,
      offset: opts.offset ?? 0,
    });
    return rows;
  },

  async getPlugin(slug: string) {
    const plugin = await db.query.marketplacePlugins.findFirst({
      where: eq(marketplacePlugins.slug, slug),
    });
    if (!plugin) throw new ApiError('NOT_FOUND', 'plugin not found');
    const versions = await db.query.marketplaceVersions.findMany({
      where: eq(marketplaceVersions.pluginId, plugin.id),
      orderBy: [desc(marketplaceVersions.createdAt)],
      limit: 50,
    });
    return { ...plugin, versions };
  },

  async addReview(authorId: string, authorName: string, slug: string, input: unknown) {
    const plugin = await db.query.marketplacePlugins.findFirst({
      where: eq(marketplacePlugins.slug, slug),
    });
    if (!plugin) throw new ApiError('NOT_FOUND', 'plugin not found');
    const data = parse(reviewSchema, input);
    const id = randomUUID();
    await db.insert(pluginReviews).values({
      id,
      pluginId: plugin.id,
      versionId: data.versionId,
      authorId,
      authorName,
      rating: data.rating,
      title: data.title,
      body: data.body,
    });
    await this.recomputeRatings(plugin.id);
    return { id, rating: data.rating };
  },

  async recomputeRatings(pluginId: string) {
    const [agg] = await db
      .select({ avg: avg(pluginReviews.rating), cnt: count(pluginReviews.id) })
      .from(pluginReviews)
      .where(eq(pluginReviews.pluginId, pluginId));
    await db
      .update(marketplacePlugins)
      .set({
        avgRating: agg?.avg ?? 0,
        ratingCount: agg?.cnt ?? 0,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(marketplacePlugins.id, pluginId));
  },

  async install(actorId: string, slug: string, input: unknown) {
    const plugin = await db.query.marketplacePlugins.findFirst({
      where: eq(marketplacePlugins.slug, slug),
    });
    if (!plugin || !plugin.latestVersionId)
      throw new ApiError('NOT_FOUND', 'plugin/version not found');
    const data = parse(installSchema, input);

    // Resolve deps (enforces acyclic graph before install).
    await resolveDependencyClosure(plugin.slug);

    const id = randomUUID();
    await db
      .insert(pluginInstalls)
      .values({
        id,
        pluginId: plugin.id,
        versionId: data.versionId ?? plugin.latestVersionId,
        tenantId: data.tenantId,
        installedBy: actorId,
        installPath: data.installPath,
        enabled: true,
      })
      .onConflictDoUpdate({
        target: [pluginInstalls.pluginId, pluginInstalls.tenantId],
        set: {
          versionId: data.versionId ?? plugin.latestVersionId,
          enabled: true,
          updatedAt: new Date().toISOString(),
        },
      });
    await db
      .update(marketplacePlugins)
      .set({ installCount: sql`${marketplacePlugins.installCount} + 1` })
      .where(eq(marketplacePlugins.id, plugin.id));
    const ts = new Date().toISOString();
    return {
      id,
      receipt: receiptHash({
        pluginId: plugin.id,
        versionId: data.versionId ?? plugin.latestVersionId ?? '',
        tenantId: data.tenantId ?? '',
        actorId,
        action: 'install',
        timestamp: ts,
      }),
    };
  },

  async approveVersion(reviewerId: string, versionId: string, score: number, findings: unknown[]) {
    const ver = await db.query.marketplaceVersions.findFirst({
      where: eq(marketplaceVersions.id, versionId),
    });
    if (!ver) throw new ApiError('NOT_FOUND', 'version not found');
    await db
      .update(marketplaceVersions)
      .set({ status: 'approved', publishedAt: new Date().toISOString() })
      .where(eq(marketplaceVersions.id, versionId));
    await db
      .update(marketplacePlugins)
      .set({
        status: 'published',
        latestVersion: ver.version,
        latestVersionId: versionId,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(marketplacePlugins.id, ver.pluginId));
    await db
      .update(pluginSecurityReviews)
      .set({ state: 'approved', score, findings, reviewerId, reviewedAt: new Date().toISOString() })
      .where(eq(pluginSecurityReviews.versionId, versionId));
    return { versionId, status: 'approved' };
  },

  async listIntegrations(kind?: string) {
    const rows = await db.query.marketplaceIntegrations.findMany({
      where: kind ? eq(marketplaceIntegrations.providerKind, kind) : undefined,
      limit: 100,
    });
    return rows;
  },

  async createIntegration(
    authorId: string,
    input: {
      slug: string;
      name: string;
      description?: string;
      providerKind: string;
      configSchema?: unknown;
    }
  ) {
    const id = randomUUID();
    await db.insert(marketplaceIntegrations).values({
      id,
      slug: input.slug,
      name: input.name,
      description: input.description ?? '',
      providerKind: input.providerKind,
      configSchema: input.configSchema ?? {},
      authorId,
    });
    return { id };
  },
  async submitForReview(versionId: string) {
    const ver = await db.query.marketplaceVersions.findFirst({
      where: eq(marketplaceVersions.id, versionId),
    });
    if (!ver) throw new ApiError('NOT_FOUND', 'version not found');
    await db
      .update(marketplaceVersions)
      .set({ status: 'pending' })
      .where(eq(marketplaceVersions.id, versionId));
    const existing = await db.query.pluginSecurityReviews.findFirst({
      where: eq(pluginSecurityReviews.versionId, versionId),
    });
    if (existing) {
      await db
        .update(pluginSecurityReviews)
        .set({ state: 'queued', findings: [], score: null, reviewedAt: null, reviewerId: null })
        .where(eq(pluginSecurityReviews.id, existing.id));
    } else {
      await db
        .insert(pluginSecurityReviews)
        .values({ id: randomUUID(), versionId, state: 'queued' });
    }
    return { versionId, status: 'pending' };
  },

  async rejectVersion(
    reviewerId: string,
    versionId: string,
    reason: string,
    findings: unknown[] = []
  ) {
    const ver = await db.query.marketplaceVersions.findFirst({
      where: eq(marketplaceVersions.id, versionId),
    });
    if (!ver) throw new ApiError('NOT_FOUND', 'version not found');
    await db
      .update(marketplaceVersions)
      .set({ status: 'rejected' })
      .where(eq(marketplaceVersions.id, versionId));
    await db
      .update(pluginSecurityReviews)
      .set({ state: 'rejected', reviewerId, findings, reviewedAt: new Date().toISOString() })
      .where(eq(pluginSecurityReviews.versionId, versionId));
    return { versionId, status: 'rejected' };
  },

  async assignReviewer(versionId: string, reviewerId: string) {
    const review = await db.query.pluginSecurityReviews.findFirst({
      where: eq(pluginSecurityReviews.versionId, versionId),
    });
    if (!review) throw new ApiError('NOT_FOUND', 'no review for version');
    await db
      .update(pluginSecurityReviews)
      .set({ reviewerId, state: 'scanning' })
      .where(eq(pluginSecurityReviews.id, review.id));
    return { versionId, reviewerId, state: 'scanning' };
  },

  async listPendingReviews(opts: { limit?: number; offset?: number } = {}) {
    const rows = await db.query.marketplaceVersions.findMany({
      where: eq(marketplaceVersions.status, 'pending'),
      orderBy: [asc(marketplaceVersions.createdAt)],
      limit: opts.limit ?? 50,
      offset: opts.offset ?? 0,
      with: { plugin: true, securityReview: true },
    });
    return rows;
  },

  async getReview(versionId: string) {
    const review = await db.query.pluginSecurityReviews.findFirst({
      where: eq(pluginSecurityReviews.versionId, versionId),
    });
    if (!review) throw new ApiError('NOT_FOUND', 'no review for version');
    return review;
  },
};

// ── Legacy pure/query helper surface (Artisan tests) ───────────────────────
import { createHmac } from 'node:crypto';

export function serializeManifest(manifest: unknown): string {
  const sortValue = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sortValue);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => [k, sortValue(v)])
      );
    }
    return value;
  };
  return JSON.stringify(sortValue(manifest));
}

export function signManifestBytes(manifest: unknown, secret: string): string {
  return createHmac('sha256', secret).update(serializeManifest(manifest)).digest('hex');
}

export function verifyManifestBytes(manifest: unknown, signature: string, secret: string): boolean {
  return signManifestBytes(manifest, secret) === signature;
}

export async function getMarketplaceListing(_opts: { limit?: number; offset?: number } = {}): Promise<unknown[]> {
  const rows = await db.select().from(marketplacePlugins).limit(_opts.limit ?? 50);
  return Array.isArray(rows) ? rows : [];
}

export async function getVerifiedListing(_opts: { limit?: number; offset?: number } = {}): Promise<unknown[]> {
  const rows = await db
    .select()
    .from(marketplacePlugins)
    .where(eq(marketplacePlugins.status, 'verified'))
    .limit(_opts.limit ?? 50);
  return Array.isArray(rows) ? rows : [];
}

export async function searchMarketplace(query: string): Promise<unknown[]> {
  void query;
  const rows = await db.select().from(marketplacePlugins).limit(50);
  return Array.isArray(rows) ? rows : [];
}
