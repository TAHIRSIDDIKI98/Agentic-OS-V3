/**
 * R1 release evidence ledger — schema v3 (current) validation.
 *
 * Why v3 exists: the 2026-07-24 v2 ledger referenced 31 artifacts, 25 of which
 * were never committed at its cited commit, and the rest had drifted. A ledger
 * that cannot be reproduced is not evidence. v3 makes reproducibility the
 * contract:
 *   1. every command has at least one committed artifact with a SHA-256;
 *   2. every hash is verified against the bytes in the repository;
 *   3. `releaseDecision` is derived, never asserted: a ledger with any non-pass
 *      command must be `blocked`, and only a fully green, fully reviewed ledger
 *      may be `approved`;
 *   4. `blockingCommandIds` must equal exactly the non-pass command set.
 *
 * The v2 file remains in the repository as history. It is superseded by
 * docs/bmad/releases/evidence/2026-11-15-ledger-supersession.md and is not a gate.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const EVIDENCE_PREFIX = 'docs/bmad/releases/evidence/';
export const LEDGER_SCHEMA_V3 = 'nexus.r1.release-evidence-ledger.v3';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = resolve(scriptDirectory, '..');

export const relativeEvidencePathSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      value.startsWith(EVIDENCE_PREFIX) &&
      !value.includes('..') &&
      !value.startsWith('/') &&
      !value.includes('\\'),
    'must be a repository-relative path under docs/bmad/releases/evidence/'
  );

export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u, 'must be a lowercase SHA-256 digest');

export const evidenceStatusSchema = z.enum(['pass', 'blocked', 'failed', 'not_run']);

export const artifactSchema = z.object({
  path: relativeEvidencePathSchema,
  sha256: sha256Schema,
  role: z.enum(['raw-command-output', 'triage', 'summary', 'report']),
});

export const commandSchemaV3 = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/u),
    evidenceClass: z.enum([
      'full-release',
      'targeted',
      'compile',
      'lint',
      'integration',
      'security',
    ]),
    command: z.string().min(1),
    workingDirectory: z.string().min(1),
    expected: z.object({
      exitCode: z.number().int().min(0),
      description: z.string().min(1),
    }),
    actual: z.object({
      /** null means "not executed"; a value means it ran and produced this code. */
      exitCode: z.number().int().min(0).nullable(),
      summary: z.string().min(1),
      observedAt: z.string().datetime({ offset: true }),
    }),
    status: evidenceStatusSchema,
    blockingReason: z.string().min(1).nullable(),
    artifacts: z.array(artifactSchema).min(1),
    reviewer: z.object({
      role: z.string().min(1),
      status: z.enum(['unassigned', 'reviewed', 'not_required']),
    }),
    rerun: z
      .object({
        status: z.enum(['passed', 'failed', 'not_run']),
        command: z.string().min(1),
        evidencePath: relativeEvidencePathSchema.nullable(),
      })
      .optional(),
  })
  .superRefine((record, context) => {
    if (record.status === 'pass' && record.actual.exitCode !== 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a pass record must have actual.exitCode = 0',
        path: ['status'],
      });
    }
    if (record.status === 'pass' && record.blockingReason !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a pass record cannot have a blockingReason',
        path: ['blockingReason'],
      });
    }
    if (record.status !== 'pass' && record.blockingReason === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a non-pass record must state its blockingReason',
        path: ['blockingReason'],
      });
    }
    if (record.status === 'not_run' && record.actual.exitCode !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a not_run record must have actual.exitCode = null',
        path: ['actual', 'exitCode'],
      });
    }
    if (record.status !== 'not_run' && record.actual.exitCode === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a command that ran must record its exit code',
        path: ['actual', 'exitCode'],
      });
    }
    if (record.rerun?.status === 'passed' && record.rerun.evidencePath === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a passed rerun requires an evidencePath',
        path: ['rerun', 'evidencePath'],
      });
    }
  });

export const ledgerSchemaV3 = z
  .object({
    schemaVersion: z.literal(LEDGER_SCHEMA_V3),
    generatedAt: z.string().datetime({ offset: true }),
    evidenceSource: z.object({
      repositoryCommit: z.string().regex(/^[a-f0-9]{40}$/u),
      branch: z.string().min(1),
      note: z.string().min(1),
    }),
    environment: z.object({
      node: z.string().min(1),
      pnpm: z.string().min(1),
      platform: z.string().min(1),
    }),
    commands: z.array(commandSchemaV3).min(1),
    releaseDecision: z.enum(['blocked', 'approved']),
    decisionDerivation: z.object({
      blockingCommandIds: z.array(z.string()),
      statement: z.string().min(1),
    }),
    supersedes: relativeEvidencePathSchema.optional(),
  })
  .superRefine((ledger, context) => {
    const ids = ledger.commands.map((command) => command.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'command ids must be unique',
        path: ['commands'],
      });
    }

    const nonPass = ledger.commands
      .filter((command) => command.status !== 'pass')
      .map((command) => command.id)
      .sort();
    const declared = [...ledger.decisionDerivation.blockingCommandIds].sort();
    if (JSON.stringify(nonPass) !== JSON.stringify(declared)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'blockingCommandIds must list exactly the non-pass commands (no omissions, no extras)',
        path: ['decisionDerivation', 'blockingCommandIds'],
      });
    }

    if (nonPass.length > 0 && ledger.releaseDecision !== 'blocked') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a ledger with any non-pass command must be blocked',
        path: ['releaseDecision'],
      });
    }
    if (nonPass.length === 0) {
      if (ledger.releaseDecision !== 'approved') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'only a fully green ledger may be approved',
          path: ['releaseDecision'],
        });
      }
      const unreviewed = ledger.commands.filter(
        (command) => command.reviewer.status !== 'reviewed'
      );
      if (unreviewed.length > 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `approval requires every command to be reviewed; unreviewed: ${unreviewed
            .map((command) => command.id)
            .join(', ')}`,
          path: ['commands'],
        });
      }
    }
  });

export type LedgerV3 = z.infer<typeof ledgerSchemaV3>;
export type CommandV3 = z.infer<typeof commandSchemaV3>;
export type ArtifactV3 = z.infer<typeof artifactSchema>;

export function absoluteRepositoryPath(path: string): string {
  const resolvedPath = resolve(repositoryRoot, path);
  const pathFromRoot = relative(repositoryRoot, resolvedPath);
  if (pathFromRoot.startsWith('..') || pathFromRoot === '') {
    throw new Error(`Evidence path escapes repository root: ${path}`);
  }
  return resolvedPath;
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(absoluteRepositoryPath(path))).digest('hex');
}

export function verifyArtifact(artifact: ArtifactV3): void {
  const artifactPath = absoluteRepositoryPath(artifact.path);
  if (!existsSync(artifactPath) || !statSync(artifactPath).isFile()) {
    throw new Error(`Evidence artifact is missing: ${artifact.path}`);
  }
  const digest = sha256File(artifact.path);
  if (digest !== artifact.sha256) {
    throw new Error(
      `Evidence artifact checksum mismatch: ${artifact.path} (expected ${artifact.sha256}, got ${digest})`
    );
  }
}

/** Validate a v3 ledger shape, hash integrity and derived decision. Throws on failure. */
export function validateLedgerV3(raw: unknown): LedgerV3 {
  const ledger = ledgerSchemaV3.parse(raw);
  for (const command of ledger.commands) {
    for (const artifact of command.artifacts) verifyArtifact(artifact);
    if (command.rerun?.evidencePath) {
      const rerunPath = absoluteRepositoryPath(command.rerun.evidencePath);
      if (!existsSync(rerunPath)) {
        throw new Error(`Rerun evidence is missing: ${command.rerun.evidencePath}`);
      }
    }
  }
  return ledger;
}

export function readJson(path: string): unknown {
  return JSON.parse(readFileSync(absoluteRepositoryPath(path), 'utf8')) as unknown;
}
