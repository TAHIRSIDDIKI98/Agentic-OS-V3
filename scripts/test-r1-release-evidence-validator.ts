import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

interface LedgerFixture {
  releaseDecision: 'blocked' | 'approved';
  commands: Array<{
    actual: { exitCode: number };
    status: 'pass' | 'blocked' | 'failed' | 'not_run';
    artifacts: Array<{ path: string }>;
  }>;
}

interface TriageFixture {
  failures: Array<{
    owner: { accountable: string };
  }>;
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '..');
const evidenceDirectory = resolve(repositoryRoot, 'docs/bmad/releases/evidence');
const sourceLedgerPath = resolve(evidenceDirectory, '2026-07-24-release-evidence-ledger.json');
const sourceTriagePath = resolve(evidenceDirectory, '2026-07-24-full-suite-triage.json');
const validatorPath = 'scripts/validate-r1-release-evidence.ts';
// Spawn node directly against the tsx CLI. Spawning `pnpm.cmd` on Windows
// requires a shell; without one the child never launches, the test sees empty
// output, and a broken harness masquerades as a broken validator.
const tsxCliPath = resolve(repositoryRoot, 'node_modules/tsx/dist/cli.mjs');

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function writeJson(path: string, value: object): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function relativeEvidencePath(name: string): string {
  return `docs/bmad/releases/evidence/${name}`;
}

function expectValidatorFailure(
  name: string,
  ledgerPath: string,
  triagePath: string,
  expectedDiagnostic: string
): void {
  const result = spawnSync(
    process.execPath,
    [tsxCliPath, validatorPath, '--ledger', ledgerPath, '--triage', triagePath],
    { cwd: repositoryRoot, encoding: 'utf8' }
  );
  if (result.status === 0) {
    throw new Error(`${name}: validator unexpectedly accepted an invalid fixture`);
  }
  const output = `${result.stdout}\n${result.stderr}`;
  if (!output.includes('validation failed') || !output.includes(expectedDiagnostic)) {
    throw new Error(
      `${name}: validator failed without the mutation-specific diagnostic: ${expectedDiagnostic}`
    );
  }
}

function main(): void {
  const suffix = `validator-fixture-${process.pid}-${Date.now()}`;
  const validLedger = readJson<LedgerFixture>(sourceLedgerPath);
  const validTriage = readJson<TriageFixture>(sourceTriagePath);
  const fixturePaths = [
    resolve(evidenceDirectory, `${suffix}-bad-exit.json`),
    resolve(evidenceDirectory, `${suffix}-unsafe-artifact.json`),
    resolve(evidenceDirectory, `${suffix}-wrong-decision.json`),
    resolve(evidenceDirectory, `${suffix}-unowned-triage.json`),
  ];

  try {
    const badExit = structuredClone(validLedger);
    badExit.commands[1]!.actual.exitCode = 1;
    writeJson(fixturePaths[0]!, badExit);
    expectValidatorFailure(
      'pass-with-nonzero-exit',
      relativeEvidencePath(`${suffix}-bad-exit.json`),
      relativeEvidencePath('2026-07-24-full-suite-triage.json'),
      'a pass record must have actual.exitCode = 0'
    );

    const unsafeArtifact = structuredClone(validLedger);
    unsafeArtifact.commands[0]!.artifacts[0]!.path = '../../outside-evidence.log';
    writeJson(fixturePaths[1]!, unsafeArtifact);
    expectValidatorFailure(
      'artifact-path-escape',
      relativeEvidencePath(`${suffix}-unsafe-artifact.json`),
      relativeEvidencePath('2026-07-24-full-suite-triage.json'),
      'must be a repository-relative path under docs/bmad/releases/evidence/'
    );

    const wrongDecision = structuredClone(validLedger);
    wrongDecision.releaseDecision = 'approved';
    writeJson(fixturePaths[2]!, wrongDecision);
    expectValidatorFailure(
      'manual-release-approval',
      relativeEvidencePath(`${suffix}-wrong-decision.json`),
      relativeEvidencePath('2026-07-24-full-suite-triage.json'),
      'releaseDecision must be derived as blocked'
    );

    const unownedTriage = structuredClone(validTriage);
    unownedTriage.failures[0]!.owner.accountable = '';
    writeJson(fixturePaths[3]!, unownedTriage);
    expectValidatorFailure(
      'unowned-triage-record',
      relativeEvidencePath('2026-07-24-release-evidence-ledger.json'),
      relativeEvidencePath(`${suffix}-unowned-triage.json`),
      'must name one accountable CODEOWNER-style owner'
    );

    console.log(
      'R1 release evidence validator negative tests passed: nonzero pass, path escape, manual approval, and unowned triage were rejected.'
    );
  } finally {
    for (const path of fixturePaths) {
      if (existsSync(path)) {
        rmSync(path);
      }
    }
  }
}

try {
  main();
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : 'Unknown validator-test error';
  console.error(`R1 release evidence validator negative tests failed: ${message}`);
  process.exitCode = 1;
}
