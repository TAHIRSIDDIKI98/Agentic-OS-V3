/**
 * Build a reproducible v3 release-evidence ledger from the current checkout.
 *
 * Every command is executed here, its combined output is written to a dated
 * artifact, and the artifact's SHA-256 is recorded. The ledger is written last.
 *
 * The commit recorded in `evidenceSource.repositoryCommit` is the commit that
 * must contain the artifacts. Run this script, commit artifacts + ledger
 * together, and the ledger is reproducible with `validate-r1-evidence-v3.ts`.
 *
 * Usage: pnpm exec tsx scripts/build-r1-evidence-v3.ts
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EVIDENCE_PREFIX, LEDGER_SCHEMA_V3, repositoryRoot, sha256File } from './r1-evidence-v3.js';

const evidenceDirectory = resolve(repositoryRoot, 'docs/bmad/releases/evidence');
const stamp = '2026-11-15';

interface CommandResult {
  id: string;
  evidenceClass: 'full-release' | 'targeted' | 'compile' | 'lint' | 'integration' | 'security';
  command: string;
  workingDirectory: string;
  expectedCode: number;
  expectedDescription: string;
  status: 'pass' | 'blocked' | 'failed' | 'not_run';
  blockingReason: string | null;
  artifact: string;
}

function git(args: string[]): string {
  const result = spawnSync('git', args, { cwd: repositoryRoot, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : '';
}

function run(id: string, command: string, cwd: string): { code: number; output: string } {
  // Strip ambient database/port config: an inherited PORT=0 fails env validation
  // and an inherited DATABASE_URL would silently switch the suite to PostgreSQL.
  const env = { ...process.env };
  delete env.PORT;
  delete env.DATABASE_URL;
  delete env.NEXUS_SQLITE_PATH;
  delete env.NODE_ENV;
  const result = spawnSync(command, {
    cwd: resolve(repositoryRoot, cwd),
    shell: true,
    encoding: 'utf8',
    timeout: 15 * 60 * 1000,
    maxBuffer: 64 * 1024 * 1024,
    env,
  });
  const output = `$ ${command}\n# cwd: ${cwd}\n# exit: ${result.status ?? 'null'}\n\n${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (result.error) {
    throw new Error(`${id}: ${result.error.message}`);
  }
  console.log(`[build-evidence] ${id}: exit ${result.status}`);
  return { code: result.status ?? 1, output };
}

function main(): void {
  mkdirSync(evidenceDirectory, { recursive: true });

  const fullSuite = run('full-suite', 'pnpm -r test', '.');
  const sdkSuite = run('sdk-suite', 'npx vitest run', 'packages/sdk');
  const typecheck = run('typecheck', 'pnpm -r typecheck', '.');
  const lint = run('lint', 'pnpm -r lint', '.');
  const claimScan = run(
    'documentation-claim-scan',
    'pnpm exec tsx scripts/scan-r1-documentation-claims.ts --check',
    '.'
  );
  const validatorTests = run(
    'evidence-validator-negative-tests',
    'pnpm exec tsx scripts/test-r1-evidence-v3.ts',
    '.'
  );
  const audit = run('production-dependency-audit', 'pnpm audit --prod --json', '.');
  // The live PostgreSQL leg runs only when the operator supplies a disposable
  // database URL. The URL itself is never embedded in the command or artifact.
  const migrationMatrix = process.env.NEXUS_PG_URL?.trim()
    ? run('migration-matrix', 'node scripts/run-r1-migration-matrix.mjs', '.')
    : null;

  const results: CommandResult[] = [
    {
      id: 'full-suite',
      evidenceClass: 'full-release',
      command: 'pnpm -r test',
      workingDirectory: '.',
      expectedCode: 0,
      expectedDescription: 'Every workspace test suite passes.',
      status: fullSuite.code === 0 ? 'pass' : 'blocked',
      blockingReason:
        fullSuite.code === 0 ? null : 'One or more workspace suites failed; see the artifact.',
      artifact: `${EVIDENCE_PREFIX}${stamp}-full-suite.log`,
    },
    {
      id: 'sdk-suite',
      evidenceClass: 'targeted',
      command: 'npx vitest run (packages/sdk)',
      workingDirectory: 'packages/sdk',
      expectedCode: 0,
      expectedDescription: 'SDK suite passes, including cross-platform path handling.',
      status: sdkSuite.code === 0 ? 'pass' : 'blocked',
      blockingReason: sdkSuite.code === 0 ? null : 'SDK suite failed; see the artifact.',
      artifact: `${EVIDENCE_PREFIX}${stamp}-sdk-suite.log`,
    },
    {
      id: 'typecheck',
      evidenceClass: 'compile',
      command: 'pnpm -r typecheck',
      workingDirectory: '.',
      expectedCode: 0,
      expectedDescription: 'All packages typecheck with a fresh, non-incremental tsc.',
      status: typecheck.code === 0 ? 'pass' : 'blocked',
      blockingReason: typecheck.code === 0 ? null : 'Typecheck failed; see the artifact.',
      artifact: `${EVIDENCE_PREFIX}${stamp}-typecheck.log`,
    },
    {
      id: 'lint',
      evidenceClass: 'lint',
      command: 'pnpm -r lint',
      workingDirectory: '.',
      expectedCode: 0,
      expectedDescription: 'Lint passes with zero errors.',
      status: lint.code === 0 ? 'pass' : 'blocked',
      blockingReason: lint.code === 0 ? null : 'Lint failed; see the artifact.',
      artifact: `${EVIDENCE_PREFIX}${stamp}-lint.log`,
    },
    {
      id: 'documentation-claim-scan',
      evidenceClass: 'security',
      command: 'scripts/scan-r1-documentation-claims.ts --check',
      workingDirectory: '.',
      expectedCode: 0,
      expectedDescription: 'No unresolved release or perfection claims remain.',
      status: claimScan.code === 0 ? 'pass' : 'blocked',
      blockingReason:
        claimScan.code === 0 ? null : 'Unresolved documentation claims remain; see the artifact.',
      artifact: `${EVIDENCE_PREFIX}${stamp}-documentation-claim-scan.log`,
    },
    {
      id: 'evidence-validator-negative-tests',
      evidenceClass: 'security',
      command: 'scripts/test-r1-evidence-v3.ts',
      workingDirectory: '.',
      expectedCode: 0,
      expectedDescription: 'The v3 validator rejects every mutated fixture for the right reason.',
      status: validatorTests.code === 0 ? 'pass' : 'blocked',
      blockingReason:
        validatorTests.code === 0 ? null : 'Validator negative tests failed; see the artifact.',
      artifact: `${EVIDENCE_PREFIX}${stamp}-evidence-validator-negative-tests.log`,
    },
    {
      id: 'production-dependency-audit',
      evidenceClass: 'security',
      command: 'pnpm audit --prod --json',
      workingDirectory: '.',
      expectedCode: 0,
      expectedDescription: 'No open production advisories, or signed dispositions for each.',
      status: audit.code === 0 ? 'pass' : 'blocked',
      blockingReason:
        audit.code === 0
          ? null
          : 'Production advisories remain open; remediation is tracked in the security triage matrix.',
      artifact: `${EVIDENCE_PREFIX}${stamp}-production-dependency-audit.log`,
    },
    ...(migrationMatrix
      ? [
          {
            id: 'migration-matrix',
            evidenceClass: 'integration' as const,
            command: 'Forward 0049→0054 and roll back 0054→0049 on SQLite and live PostgreSQL, then reapply.',
            workingDirectory: '.',
            expectedCode: 0,
            expectedDescription: 'Migration matrix green on every executed engine.',
            status: migrationMatrix.code === 0 ? ('pass' as const) : ('blocked' as const),
            blockingReason:
              migrationMatrix.code === 0
                ? null
                : 'A forward, rollback or reapply check failed; see the artifact.',
            artifact: `${EVIDENCE_PREFIX}${stamp}-migration-matrix.log`,
          },
        ]
      : []),
  ];

  const outputs: Record<string, { code: number; output: string }> = {
    'full-suite': fullSuite,
    'sdk-suite': sdkSuite,
    typecheck,
    lint,
    'documentation-claim-scan': claimScan,
    'evidence-validator-negative-tests': validatorTests,
    'production-dependency-audit': audit,
    ...(migrationMatrix ? { 'migration-matrix': migrationMatrix } : {}),
  };

  for (const result of results) {
    writeFileSync(
      resolve(repositoryRoot, result.artifact),
      outputs[result.id]!.output.replace(/\r\n/g, '\n'),
      'utf8'
    );
  }

  const notRun: Array<Omit<CommandResult, 'artifact'> & { artifact: string; command: string }> = [
    ...(!migrationMatrix
      ? [
          {
            id: 'migration-matrix',
            evidenceClass: 'integration' as const,
            command:
              'Forward 0049→0054 and roll back 0054→0049 on SQLite and live PostgreSQL, then reapply.',
            workingDirectory: '.',
            expectedCode: 0,
            expectedDescription: 'Migration matrix green on every executed engine.',
            status: 'not_run' as const,
            blockingReason:
              'NEXUS_PG_URL was not set, so only the SQLite leg could run. Supply a disposable PostgreSQL URL to execute the full matrix.',
            artifact: `${EVIDENCE_PREFIX}${stamp}-unperformed-gates.md`,
          },
        ]
      : []),
    {
      id: 'clean-machine-golden-path',
      evidenceClass: 'integration',
      command:
        '14-step golden path on a pristine machine: init → capture → governed task → approval → execute → crash recovery → export/import.',
      workingDirectory: 'clean supported machine',
      expectedCode: 0,
      expectedDescription: '14/14 steps pass with no data repair; artifacts retained.',
      status: 'not_run',
      blockingReason:
        'Not executed in this batch: requires a clean supported machine and a built frontend. Owner: W4.',
      artifact: `${EVIDENCE_PREFIX}${stamp}-unperformed-gates.md`,
    },
    {
      id: 'security-triage-review',
      evidenceClass: 'security',
      command: 'Independent review of the security triage matrix and retest evidence.',
      workingDirectory: 'docs/bmad/security-triage-matrix-2026-08-24.md',
      expectedCode: 0,
      expectedDescription: 'Independent reviewer signs the matrix and every retest.',
      status: 'not_run',
      blockingReason:
        'Reviewer not yet assigned (E10-S30). Only that reviewer may close this record.',
      artifact: `${EVIDENCE_PREFIX}${stamp}-unperformed-gates.md`,
    },
  ];

  writeFileSync(
    resolve(repositoryRoot, `${EVIDENCE_PREFIX}${stamp}-unperformed-gates.md`),
    [
      `# Unperformed release gates — ${stamp}`,
      '',
      'These gates are **not evidence of failure**; they are unexecuted. They keep the release',
      'decision `blocked` until each produces a retained artifact.',
      '',
      ...notRun.map(
        (gate) =>
          `## ${gate.id}\n\n- Command/procedure: ${gate.command}\n- Blocking reason: ${gate.blockingReason}\n`
      ),
      '',
    ].join('\n'),
    'utf8'
  );

  const commands = [
    ...results.map((result) => ({
      id: result.id,
      evidenceClass: result.evidenceClass,
      command: result.command,
      workingDirectory: result.workingDirectory,
      expected: { exitCode: result.expectedCode, description: result.expectedDescription },
      actual: {
        exitCode: outputs[result.id]!.code,
        summary:
          outputs[result.id]!.code === 0
            ? 'Command completed successfully; raw output retained.'
            : `Command exited ${outputs[result.id]!.code}; raw output retained.`,
        observedAt: new Date().toISOString(),
      },
      status: result.status,
      blockingReason: result.blockingReason,
      artifacts: [
        { path: result.artifact, sha256: sha256File(result.artifact), role: 'raw-command-output' as const },
      ],
      reviewer: { role: 'independent E10-S30 reviewer', status: 'unassigned' as const },
    })),
    ...notRun.map((result) => ({
      id: result.id,
      evidenceClass: result.evidenceClass,
      command: result.command,
      workingDirectory: result.workingDirectory,
      expected: { exitCode: result.expectedCode, description: result.expectedDescription },
      actual: {
        exitCode: null,
        summary: 'Not executed in this batch.',
        observedAt: new Date().toISOString(),
      },
      status: 'not_run' as const,
      blockingReason: result.blockingReason,
      artifacts: [
        { path: result.artifact, sha256: sha256File(result.artifact), role: 'summary' as const },
      ],
      reviewer: { role: 'independent E10-S30 reviewer', status: 'unassigned' as const },
    })),
  ];

  const blocking = commands.filter((command) => command.status !== 'pass').map((command) => command.id);
  const ledger = {
    schemaVersion: LEDGER_SCHEMA_V3,
    generatedAt: new Date().toISOString(),
    evidenceSource: {
      repositoryCommit: git(['rev-parse', 'HEAD']),
      branch: git(['rev-parse', '--abbrev-ref', 'HEAD']) || 'unknown',
      note:
        'Generated from the working tree at the recorded commit; artifacts are committed in the same batch. Raw command output is retained verbatim (shell exit codes included).',
    },
    environment: {
      node: process.version,
      pnpm: (spawnSync('pnpm', ['--version'], { encoding: 'utf8' }).stdout ?? '').trim() || 'unknown',
      platform: `${process.platform}-${process.arch}`,
    },
    commands,
    releaseDecision: blocking.length > 0 ? 'blocked' : 'approved',
    decisionDerivation: {
      blockingCommandIds: blocking,
      statement:
        'Derived from the commands array: any non-pass record blocks the release. Passing compile, lint and targeted records cannot clear a failing full suite, an open advisory set, or unexecuted drills.',
    },
    supersedes: `${EVIDENCE_PREFIX}2026-07-24-release-evidence-ledger.json`,
  };

  const ledgerPath = resolve(repositoryRoot, `${EVIDENCE_PREFIX}${stamp}-release-evidence-ledger.json`);
  writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
  console.log(`[build-evidence] wrote ${ledgerPath}`);
  console.log(`[build-evidence] decision=${ledger.releaseDecision} blocking=${blocking.join(',')}`);
}

main();
