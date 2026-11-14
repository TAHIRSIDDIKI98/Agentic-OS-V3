/**
 * CI drift gate for the README MCP surface.
 *
 * The README used to advertise tools that were never registered
 * (nexus_agents_list, nexus_agents_spawn, nexus_browser_*) and resources that do
 * not exist. The tables are now generated from the live server registration by
 * src/scripts/mcp-tool-table.ts; this test fails whenever they disagree, so the
 * docs cannot drift again without a red build.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const directories: string[] = [];
let previousSqlitePath: string | undefined;

beforeEach(() => {
  previousSqlitePath = process.env.NEXUS_SQLITE_PATH;
  vi.resetModules();
  const directory = mkdtempSync(join(tmpdir(), 'nexus-readme-'));
  directories.push(directory);
  process.env.NEXUS_SQLITE_PATH = join(directory, 'readme.db');
  delete process.env.DATABASE_URL;
  process.env.PORT = '9900';
});

afterEach(async () => {
  try {
    const { closeDb } = await import('../src/db/client.js');
    await closeDb();
  } catch {
    /* never opened, or already closed */
  }
  vi.resetModules();
  if (previousSqlitePath === undefined) delete process.env.NEXUS_SQLITE_PATH;
  else process.env.NEXUS_SQLITE_PATH = previousSqlitePath;
  for (const directory of directories.splice(0)) {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      /* Windows may hold the handle briefly */
    }
  }
});

describe('README MCP surface', () => {
  it('matches the registered tools and resources', async () => {
    const { compareWithReadme, defaultReadmePath, describeMcpSurface } = await import(
      '../src/scripts/mcp-tool-table.js'
    );

    const surface = await describeMcpSurface();
    const markdown = await readFile(defaultReadmePath(), 'utf8');
    const drift = compareWithReadme(markdown, surface);

    expect(drift.problems).toEqual([]);
  });

  it('declares a scope for every registered tool', async () => {
    const { describeMcpSurface } = await import('../src/scripts/mcp-tool-table.js');

    const surface = await describeMcpSurface();
    expect(surface.tools.length).toBeGreaterThan(0);
    expect(surface.tools.filter((tool) => tool.scope === 'UNREGISTERED')).toEqual([]);
  });
});
