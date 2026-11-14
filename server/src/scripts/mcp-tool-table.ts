/**
 * mcp-tool-table.ts — single source of truth for the README MCP surface.
 *
 * The README's MCP tables drifted from the code (it advertised tools that were
 * never registered). This module lists the tools/resources from the REAL server
 * via the SDK's in-memory transport, renders the Markdown tables, and can check
 * or rewrite the README. A unit test runs the same check in CI.
 *
 *   npx tsx server/src/scripts/mcp-tool-table.ts            # print + drift check
 *   npx tsx server/src/scripts/mcp-tool-table.ts --write    # rewrite README tables
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createNexusMcpServer, TOOL_SCOPES } from '../mcp.js';
import type { Scope } from '../lib/security.js';

export const ALL_SCOPES: Scope[] = [
  'memory:read',
  'memory:write',
  'skill:read',
  'skill:write',
  'brain:admin',
  'vault:read',
  'vault:write',
  'safety:write',
  'audit:read',
];

export interface McpToolRow {
  name: string;
  description: string;
  scope: string;
}

export interface McpResourceRow {
  uri: string;
  description: string;
}

export interface McpSurface {
  tools: McpToolRow[];
  resources: McpResourceRow[];
}

export const TOOLS_HEADING = '### MCP Tools';
export const RESOURCES_HEADING = '### MCP Resources';

/** List the tools and resources the running server actually registers. */
export async function describeMcpSurface(): Promise<McpSurface> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createNexusMcpServer('tool-table-generator', ALL_SCOPES);
  const client = new Client({ name: 'tool-table-generator', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const [tools, resources] = await Promise.all([client.listTools(), client.listResources()]);
    return {
      tools: tools.tools
        .map((tool) => ({
          name: tool.name,
          description: (tool.description ?? '').replace(/\s+/g, ' ').trim(),
          scope: TOOL_SCOPES[tool.name as keyof typeof TOOL_SCOPES] ?? 'UNREGISTERED',
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      resources: resources.resources
        .map((resource) => ({
          uri: resource.uri,
          description: (resource.description ?? '').replace(/\s+/g, ' ').trim(),
        }))
        .sort((a, b) => a.uri.localeCompare(b.uri)),
    };
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|');
}

export function renderToolTable(surface: McpSurface): string {
  const rows = surface.tools.map(
    (tool) => `| \`${tool.name}\` | ${escapeCell(tool.description)} | \`${tool.scope}\` |`
  );
  return ['| Tool | Description | Scopes |', '| --- | --- | --- |', ...rows].join('\n');
}

export function renderResourceTable(surface: McpSurface): string {
  const rows = surface.resources.map(
    (resource) => `| \`${resource.uri}\` | ${escapeCell(resource.description)} |`
  );
  return ['| Resource URI | Description |', '| --- | --- |', ...rows].join('\n');
}

interface ParsedTable {
  header: string[];
  rows: string[][];
  start: number;
  end: number;
}

/** Find the first Markdown table after a heading and parse its cells. */
function tableAfterHeading(markdown: string, heading: string): ParsedTable | null {
  const lines = markdown.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => line.trim() === heading);
  if (headingIndex === -1) return null;

  let start = -1;
  for (let i = headingIndex + 1; i < lines.length; i++) {
    if (lines[i]!.trim().startsWith('|')) {
      start = i;
      break;
    }
    if (lines[i]!.startsWith('#')) return null;
  }
  if (start === -1) return null;

  let end = start;
  while (end < lines.length && lines[end]!.trim().startsWith('|')) end++;

  const cells = (line: string): string[] =>
    line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => cell.trim().replace(/`/g, ''));

  const header = cells(lines[start]!);
  const rows = lines
    .slice(start + 2, end)
    .map(cells)
    .filter((row) => row.some((cell) => cell !== ''));
  return { header, rows, start, end };
}

export interface ReadmeDrift {
  ok: boolean;
  problems: string[];
}

/** Compare the README tables with the registered surface. */
export function compareWithReadme(markdown: string, surface: McpSurface): ReadmeDrift {
  const problems: string[] = [];

  const toolTable = tableAfterHeading(markdown, TOOLS_HEADING);
  if (!toolTable) {
    problems.push(`README is missing the "${TOOLS_HEADING}" table`);
  } else {
    const documented = toolTable.rows.map((row) => row[0] ?? '').sort();
    const actual = surface.tools.map((tool) => tool.name).sort();
    const missing = actual.filter((name) => !documented.includes(name));
    const phantom = documented.filter((name) => !actual.includes(name));
    if (missing.length) problems.push(`README omits registered tools: ${missing.join(', ')}`);
    if (phantom.length) problems.push(`README documents non-existent tools: ${phantom.join(', ')}`);

    for (const row of toolTable.rows) {
      const [name, , scope] = row;
      const tool = surface.tools.find((entry) => entry.name === name);
      if (tool && scope && scope !== tool.scope) {
        problems.push(`README scope for ${name} is "${scope}", code says "${tool.scope}"`);
      }
    }
  }

  const resourceTable = tableAfterHeading(markdown, RESOURCES_HEADING);
  if (!resourceTable) {
    problems.push(`README is missing the "${RESOURCES_HEADING}" table`);
  } else {
    const documented = resourceTable.rows.map((row) => row[0] ?? '').sort();
    const actual = surface.resources.map((resource) => resource.uri).sort();
    const missing = actual.filter((uri) => !documented.includes(uri));
    const phantom = documented.filter((uri) => !actual.includes(uri));
    if (missing.length) problems.push(`README omits registered resources: ${missing.join(', ')}`);
    if (phantom.length) problems.push(`README documents non-existent resources: ${phantom.join(', ')}`);
  }

  return { ok: problems.length === 0, problems };
}

/** Replace the two README tables in place, leaving everything else untouched. */
export function rewriteReadmeTables(markdown: string, surface: McpSurface): string {
  const replace = (source: string, heading: string, table: string): string => {
    const parsed = tableAfterHeading(source, heading);
    if (!parsed) throw new Error(`README is missing the "${heading}" table`);
    const lines = source.split(/\r?\n/);
    lines.splice(parsed.start, parsed.end - parsed.start, ...table.split('\n'));
    return lines.join('\n');
  };
  const withTools = replace(markdown, TOOLS_HEADING, renderToolTable(surface));
  return replace(withTools, RESOURCES_HEADING, renderResourceTable(surface));
}

export function defaultReadmePath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../../README.md');
}

async function main(): Promise<void> {
  const surface = await describeMcpSurface();
  const readmePath = defaultReadmePath();
  const markdown = await readFile(readmePath, 'utf8');

  if (process.argv.includes('--write')) {
    await writeFile(readmePath, rewriteReadmeTables(markdown, surface), 'utf8');
    console.log(`Rewrote MCP tables in ${readmePath}`);
    return;
  }

  const drift = compareWithReadme(markdown, surface);
  console.log(renderToolTable(surface));
  console.log('');
  console.log(renderResourceTable(surface));
  if (!drift.ok) {
    console.error('\nREADME drift detected:');
    for (const problem of drift.problems) console.error(` - ${problem}`);
    process.exitCode = 1;
  } else {
    console.log('\nREADME MCP tables match the server registration.');
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  await main();
}
