/**
 * Negative tests for the v3 evidence validator.
 *
 * A validator that accepts a pass record with a nonzero exit, an escaping
 * artifact path, a forged hash, or a manually approved blocked decision is not
 * a gate. Each mutation below must fail with its specific diagnostic.
 *
 * The fixture is constructed here from a real committed artifact, so this test
 * does not depend on the order in which the evidence batch is built.
 */
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EVIDENCE_PREFIX, sha256File } from './r1-evidence-v3.js';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '..');
const evidenceDirectory = resolve(repositoryRoot, 'docs/bmad/releases/evidence');
const validatorPath = 'scripts/validate-r1-evidence-v3.ts';
const tsxCliPath = resolve(repositoryRoot, 'node_modules/tsx/dist/cli.mjs');

const artifactPath = `${EVIDENCE_PREFIX}2026-11-15-sdk-suite.log`;
const artifactSha = sha256File(artifactPath);

interface LedgerFixture {
  schemaVersion: string;
  generatedAt: string;
  evidenceSource: { repositoryCommit: string; branch: string; note: string };
  environment: { node: string; pnpm: string; platform: string };
  commands: Array<{
    id: string;
    evidenceClass: 'targeted' | 'full-release' | 'compile' | 'lint' | 'security' | 'integration';
    command: string;
    workingDirectory: string;
    expected: { exitCode: number; description: string };
    actual: { exitCode: number | null; summary: string; observedAt: string };
    status: 'pass' | 'blocked' | 'failed' | 'not_run';
    blockingReason: string | null;
    artifacts: Array<{ path: string; sha256: string; role: 'raw-command-output' }>;
    reviewer: { role: string; status: 'unassigned' | 'reviewed' | 'not_required' };
  }>;
  releaseDecision: 'blocked' | 'approved';
  decisionDerivation: { blockingCommandIds: string[]; statement: string };
}

function command(
  overrides: Partial<LedgerFixture['commands'][number]> & { id: string }
): LedgerFixture['commands'][number] {
  return {
    evidenceClass: 'targeted',
    command: 'fixture command',
    workingDirectory: '.',
    expected: { exitCode: 0, description: 'fixture expectation' },
    actual: { exitCode: 0, summary: 'fixture summary', observedAt: new Date().toISOString() },
    status: 'pass',
    blockingReason: null,
    artifacts: [{ path: artifactPath, sha256: artifactSha, role: 'raw-command-output' }],
    reviewer: { role: 'independent E30 reviewer', status: 'unassigned' },
    ...overrides,
  };
}

function baseLedger(): LedgerFixture {
  return {
    schemaVersion: 'nexus.r1.release-evidence-ledger.v3',
    generatedAt: new Date().toISOString(),
    evidenceSource: { repositoryCommit: '0'.repeat(40), branch: 'fixture', note: 'negative-test fixture' },
    environment: { node: process.version, pnpm: '9.15.0', platform: process.platform },
    commands: [
      command({ id: 'passing' }),
      command({
        id: 'blocking',
        status: 'blocked',
        actual: { exitCode: 1, summary: 'fixture failure', observedAt: new Date().toISOString() },
        blockingReason: 'fixture blocker',
      }),
      command({
        id: 'unexecuted',
        status: 'not_run',
        actual: { exitCode: null, summary: 'not executed', observedAt: new Date().toISOString() },
        blockingReason: 'fixture not run',
      }),
    ],
    releaseDecision: 'blocked',
    decisionDerivation: {
      blockingCommandIds: ['blocking', 'unexecuted'],
      statement: 'fixture: derived from non-pass commands',
    },
  };
}

function expectFailure(name: string, fixture: LedgerFixture, expected: string): void {
  const path = resolve(evidenceDirectory, `v3-fixture-${process.pid}-${Date.now()}-${name}.json`);
  writeFileSync(path, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
  try {
    const result = spawnSync(process.execPath, [tsxCliPath, validatorPath, '--ledger', path], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    });
    if (result.status === 0) throw new Error(`${name}: validator unexpectedly accepted the fixture`);
    const output = `${result.stdout}\n${result.stderr}`;
    if (!output.includes('validation failed') || !output.includes(expected)) {
      throw new Error(
        `${name}: missing diagnostic "${expected}"\n--- validator output ---\n${output}`
      );
    }
  } finally {
    if (existsSync(path)) rmSync(path);
  }
}

function main(): void {
  const badExit = structuredClone(baseLedger());
  badExit.commands[0]!.actual.exitCode = 1;
  expectFailure('pass-with-nonzero-exit', badExit, 'a pass record must have actual.exitCode = 0');

  const pathEscape = structuredClone(baseLedger());
  pathEscape.commands[0]!.artifacts[0]!.path = '../../outside-evidence.log';
  expectFailure(
    'artifact-path-escape',
    pathEscape,
    'must be a repository-relative path under docs/bmad/releases/evidence/'
  );

  const forgedHash = structuredClone(baseLedger());
  forgedHash.commands[0]!.artifacts[0]!.sha256 = '0'.repeat(64);
  expectFailure('artifact-checksum', forgedHash, 'Evidence artifact checksum mismatch');

  const manualApproval = structuredClone(baseLedger());
  manualApproval.releaseDecision = 'approved';
  expectFailure('manual-approval', manualApproval, 'must be blocked');

  const wrongBlockingList = structuredClone(baseLedger());
  wrongBlockingList.decisionDerivation.blockingCommandIds = [];
  expectFailure('blocking-list-mismatch', wrongBlockingList, 'must list exactly the non-pass commands');

  const notRunWithExit = structuredClone(baseLedger());
  notRunWithExit.commands[2]!.actual.exitCode = 0;
  expectFailure('not-run-with-exit-code', notRunWithExit, 'must have actual.exitCode = null');

  const unreviewedApproval = structuredClone(baseLedger());
  unreviewedApproval.commands = [command({ id: 'green' })];
  unreviewedApproval.decisionDerivation.blockingCommandIds = [];
  unreviewedApproval.releaseDecision = 'approved';
  expectFailure('approval-without-review', unreviewedApproval, 'approval requires every command to be reviewed');

  console.log(
    'R1 v3 evidence validator negative tests passed: nonzero pass, path escape, forged hash, manual approval, blocking-list mismatch, not_run-with-exit, and unreviewed approval were all rejected.'
  );
}

try {
  main();
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : 'Unknown validator-test error';
  console.error(`R1 v3 evidence validator negative tests failed: ${message}`);
  process.exitCode = 1;
}
