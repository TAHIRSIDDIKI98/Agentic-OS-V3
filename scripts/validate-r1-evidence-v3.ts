/**
 * CLI: validate the current v3 release-evidence ledger.
 *
 * Usage: pnpm exec tsx scripts/validate-r1-evidence-v3.ts [--ledger <path>]
 * Exit 0 only when the schema, every artifact hash, and the derived decision
 * are all consistent.
 */
import { z } from 'zod';
import { readJson, validateLedgerV3 } from './r1-evidence-v3.js';

const defaultLedger = 'docs/bmad/releases/evidence/2026-11-15-release-evidence-ledger.json';

function main(): void {
  const values = process.argv.slice(2);
  let ledgerPath = defaultLedger;
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === '--ledger' && values[index + 1]) {
      ledgerPath = values[index + 1]!;
      index += 1;
    } else {
      throw new Error('Usage: validate-r1-evidence-v3.ts [--ledger <path>]');
    }
  }

  const ledger = validateLedgerV3(readJson(ledgerPath));
  console.log(
    `R1 v3 release evidence valid: decision=${ledger.releaseDecision}; commands=${ledger.commands.length}; blocking=${ledger.decisionDerivation.blockingCommandIds.join(',') || 'none'}; commit=${ledger.evidenceSource.repositoryCommit.slice(0, 12)}.`
  );
}

try {
  main();
} catch (error: unknown) {
  if (error instanceof z.ZodError) {
    console.error('R1 v3 release evidence schema validation failed:');
    for (const issue of error.issues) {
      console.error(`- ${issue.path.join('.') || '<root>'}: ${issue.message}`);
    }
  } else {
    const message = error instanceof Error ? error.message : 'Unknown validation error';
    console.error(`R1 v3 release evidence validation failed: ${message}`);
  }
  process.exitCode = 1;
}
