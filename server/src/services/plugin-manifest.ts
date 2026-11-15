/**
 * plugin-manifest.ts
 * ──────────────────
 * Pillar II companion: typed manifest schema + validator.
 *
 * A plugin manifest describes WHAT a plugin may do and HOW the runtime should
 * treat it. It is signed by the publisher's ed25519 key and the signature is
 * verified at load time (see wasm-plugin-runtime.ts).
 *
 * The schema is intentionally small: the only thing that varies wildly is the
 * `capabilities` list. Everything else is policy / metadata.
 */
import { z } from 'zod';

/* ─── Capability spec ───────────────────────────────────────────────────── */

export const CapabilitySpecSchema = z
  .object({
    /** Exact capability string, e.g. "http.outbound.api.example.com" */
    exact: z.string().optional(),
    /** Prefix to match, e.g. "skill.invoke." → any "skill.invoke.X" is allowed */
    prefix: z.string().optional(),
    prefixExcept: z.array(z.string().min(1).max(512)).max(50).optional(),
    /** Resource limits for this capability (e.g. max bytes, max calls/sec). */
    limits: z
      .object({
        maxBytes: z.number().int().nonnegative().optional(),
        maxCallsPerMin: z.number().int().positive().optional(),
        maxFuelPerCall: z.number().int().positive().optional(),
      })
      .optional(),
  })
  .refine((c) => Boolean(c.exact || c.prefix), {
    message: 'capability must have either `exact` or `prefix`',
  });

export type CapabilitySpec = z.infer<typeof CapabilitySpecSchema>;

/* ─── Sandbox config ────────────────────────────────────────────────────── */

export const SandboxConfigSchema = z.object({
  /** Max WASM fuel per invocation (default 1e9). */
  maxFuel: z.number().int().positive().default(1_000_000_000),
  /** Max wall-clock ms per invocation (default 5000). */
  maxWallMs: z.number().int().positive().default(5_000),
  /** Max output bytes (default 1 MiB). */
  maxOutputBytes: z
    .number()
    .int()
    .positive()
    .default(1 << 20),
  /** Whether the plugin may access the network. */
  allowNetwork: z.boolean().default(false),
  /** Whether the plugin may write to the filesystem. */
  allowFilesystem: z.boolean().default(false),
  /** Whether the plugin may read env vars (BLOCKING by default). */
  allowEnv: z.boolean().default(false),
});

export type SandboxConfig = z.infer<typeof SandboxConfigSchema>;

/* ─── Full manifest ──────────────────────────────────────────────────────── */

export const PluginManifestSchema = z.object({
  /** Protocol version. Current: 1. */
  schemaVersion: z.literal(1).default(1),
  /** Plugin name (reverse-DNS, e.g. "io.nexus.summarizer"). */
  name: z
    .string()
    .min(3)
    .max(200)
    .regex(/^[a-z0-9][a-z0-9._-]*$/i),
  /** Plugin version (semver). */
  version: z.string().regex(/^\d+\.\d+\.\d+(-[a-z0-9.-]+)?$/),
  /** Display description. */
  description: z.string().max(2000).default(''),
  /** POSIX ring that the plugin runs in (0-3); ignored if ringOverride is set at install. */
  ring: z.number().int().min(0).max(3).default(2),
  /** Capabilities granted to the plugin. */
  capabilities: z.array(CapabilitySpecSchema).min(1).max(50),
  /** Sandbox config. */
  sandbox: SandboxConfigSchema.prefault({}),
  /** Free-form tags for discovery. */
  tags: z.array(z.string().min(1).max(64)).max(20).default([]),
  /** Plugin homepage / docs URL (optional). */
  homepage: z.string().url().optional(),
  /** SPDX license identifier (optional). */
  license: z.string().max(64).optional(),
  /** Dependencies — names of other plugins this one requires. */
  dependsOn: z.array(z.string()).max(20).default([]),
  /** Author/publisher id (used for signature attestation). */
  author: z.string().max(200).default(''),
  /** Ed25519 signature (hex) over the manifest body, for attestation. */
  signature: z.string().min(64).max(256).optional(),
  /** Hard execution wall-clock timeout (ms) for the resource fuse. */
  timeoutMs: z.number().int().positive().max(600_000).default(5_000),
  /** Hard fuel ceiling for the resource fuse. */
  maxFuel: z.number().int().positive().max(10_000_000).default(100_000),
});

export type PluginManifest = z.infer<typeof PluginManifestSchema>;

/* ─── Validator ──────────────────────────────────────────────────────────── */

/** Throws ZodError on invalid input. Returns the parsed (and default-filled) manifest. */
export function validateManifest(input: unknown): PluginManifest {
  return PluginManifestSchema.parse(input);
}

/** Non-throwing variant for the plugin marketplace UI. */
export function safeValidateManifest(
  input: unknown
):
  | { ok: true; manifest: PluginManifest }
  | { ok: false; errors: Array<{ path: string; message: string }> } {
  const result = PluginManifestSchema.safeParse(input);
  if (result.success) return { ok: true, manifest: result.data };
  return {
    ok: false,
    errors: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
  };
}

/* ─── Diff helpers (used by the marketplace UI "update available" banner) ── */

export interface ManifestDiff {
  added: string[];
  removed: string[];
  changed: string[];
  from: string;
  to: string;
}

/** Compare two manifest versions, returning what changed in capabilities + sandbox. */
export function diffManifests(prev: PluginManifest, next: PluginManifest): ManifestDiff {
  const prevCaps = new Set(prev.capabilities.flatMap(capabilityKeys));
  const nextCaps = new Set(next.capabilities.flatMap(capabilityKeys));
  const added = [...nextCaps].filter((k) => !prevCaps.has(k));
  const removed = [...prevCaps].filter((k) => !nextCaps.has(k));
  const changed: string[] = [];
  if (JSON.stringify(prev.sandbox) !== JSON.stringify(next.sandbox)) changed.push('sandbox');
  if (prev.ring !== next.ring) changed.push('ring');
  if (JSON.stringify(prev.dependsOn) !== JSON.stringify(next.dependsOn)) changed.push('dependsOn');
  return { added, removed, changed, from: prev.version, to: next.version };
}

function capabilityKeys(c: CapabilitySpec): string[] {
  return [c.exact, c.prefix].filter((k): k is string => Boolean(k));
}

/* ─── Example manifest (used in docs and tests) ──────────────────────────── */

export const EXAMPLE_MANIFEST: PluginManifest = {
  schemaVersion: 1,
  name: 'io.nexus.examples.summarizer',
  version: '1.0.0',
  description: 'Summarizes text passages via the LLM gateway.',
  author: 'nexus-labs',
  ring: 2,
  timeoutMs: 5_000,
  maxFuel: 100_000,
  capabilities: [
    { exact: 'llm.invoke', limits: { maxFuelPerCall: 5_000_000, maxCallsPerMin: 30 } },
    { prefix: 'skill.invoke.' },
  ],
  sandbox: {
    allowNetwork: false,
    allowFilesystem: false,
    allowEnv: false,
    maxFuel: 50_000_000,
    maxWallMs: 10_000,
    maxOutputBytes: 1 << 20,
  },
  tags: ['summarization', 'text'],
  license: 'Apache-2.0',
  dependsOn: [],
};
