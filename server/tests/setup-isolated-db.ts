/**
 * Per-file database isolation for the unit suite.
 *
 * Every test file used to share `server/agentic-os.db`. Files run in parallel
 * workers, so a suite that calls `db.delete(...)` on whole tables (memory/brain
 * tests do) could wipe rows another file had just written, and count-based
 * assertions saw other files' rows. That made the merge gate nondeterministic:
 * the same commit produced 0, 1 or 8 memories depending on scheduling.
 *
 * Each test file now gets a fresh SQLite file. The client creates the schema for
 * it on open (baseline SQL), exactly as a first run against a clean checkout
 * does. Files that need a specific path (contract tests) still set their own
 * NEXUS_SQLITE_PATH and are unaffected.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

const directory = mkdtempSync(join(tmpdir(), 'nexus-vitest-db-'));
process.env.NEXUS_SQLITE_PATH = join(directory, 'test.db');

afterAll(() => {
  try {
    rmSync(directory, { recursive: true, force: true });
  } catch {
    // Windows may still hold the SQLite handle; the OS temp dir is disposable.
  }
});
